// 阶段 10：上下文压缩的纯函数核心。压缩不删除历史，只追加 compaction entry；
// 这里只负责「什么时候压、压到哪、多大」，投影与摘要在 session-context.ts / 本文件后半。
import type { Message, Usage } from "@mini-agent/ai";
import type { SessionEntry, SessionEntryOf } from "./session-types.ts";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTurns: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTurns: 4,
};

export interface ProjectedSessionEntry {
	source: SessionEntry;
	messages: Message[];
}

export interface SessionContextProjection {
	entries: ProjectedSessionEntry[];
	messages: Message[];
	latestCompaction?: SessionEntryOf<"compaction">;
}

// 包内共享（AgentSession 归一化配置、测试），不从 package index 再导出。
export function normalizeCompactionOptions(
	contextWindow: number | undefined,
	settings: Partial<CompactionSettings> | undefined,
): { contextWindow: number; settings: CompactionSettings } {
	const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	if (!Number.isSafeInteger(window) || window < 1)
		throw new Error("contextWindow must be a positive safe integer");
	const merged: CompactionSettings = {
		enabled: settings?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
		reserveTokens:
			settings?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		keepRecentTurns:
			settings?.keepRecentTurns ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTurns,
	};
	if (!Number.isSafeInteger(merged.reserveTokens) || merged.reserveTokens < 0)
		throw new Error("reserveTokens must be a non-negative safe integer");
	if (merged.reserveTokens >= window)
		throw new Error("reserveTokens must be smaller than contextWindow");
	if (!Number.isSafeInteger(merged.keepRecentTurns) || merged.keepRecentTurns < 1)
		throw new Error("keepRecentTurns must be a positive safe integer");
	return { contextWindow: window, settings: merged };
}

// 严格大于：刚好顶到 reserve 边界不压缩，超过 1 token 才压缩（计划固定语义）。
// 阈值公式只许活在这里，调用方不得复制。
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}

// 逐条粗估：chars / 4 上取整。system sections、tool 声明（含移除的名字）、
// text 与 toolCall（name + JSON 参数）都计入；这是阈值判定的下限，不求精确。
export function estimateTokens(message: Message): number {
	let chars = 0;
	if (message.role === "system") {
		for (const section of message.sections) chars += section.text.length;
		for (const tool of message.toolsAdded ?? []) chars += JSON.stringify(tool).length;
		for (const name of message.toolsRemoved ?? []) chars += name.length;
	} else {
		for (const block of message.content) {
			chars += block.type === "text"
				? block.text.length
				: block.name.length + JSON.stringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / 4);
}

// usage 校准点：provider 报数的 assistant 才可信。error/aborted 是失败诊断、
// 全零是占位（fake provider），都不能当校准点。
function validUsage(message: Message): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted")
		return undefined;
	const usage = message.usage;
	if (!usage || usage.inputTokens + usage.outputTokens === 0) return undefined;
	return usage;
}

// 阈值判定用的上下文总量：优先用 compaction 之后最后一条有效 assistant usage
// 校准（inputTokens 已含 cache read/write，不得再重复加），其后的消息逐条粗估。
// 没有有效校准点时对整个投影粗估。latest compaction 之前的 usage 量的是
// 压缩前的大上下文，对新投影已失效——校准区从 C.parent 之后开始。
export function estimateContextTokens(
	projection: SessionContextProjection,
): number {
	const entries = projection.entries;
	const boundary = projection.latestCompaction?.parentId;
	let start = 0;
	if (boundary !== undefined) {
		const index = entries.findIndex((entry) => entry.source.id === boundary);
		if (index >= 0) start = index + 1;
	}
	let calibration: { entryIndex: number; messageIndex: number; usage: Usage } | undefined;
	for (let i = entries.length - 1; i >= start && !calibration; i--) {
		const messages = entries[i]!.messages;
		for (let j = messages.length - 1; j >= 0; j--) {
			const usage = validUsage(messages[j]!);
			if (usage) {
				calibration = { entryIndex: i, messageIndex: j, usage };
				break;
			}
		}
	}
	if (!calibration) {
		return projection.messages.reduce(
			(total, message) => total + estimateTokens(message),
			0,
		);
	}
	let total = calibration.usage.inputTokens + calibration.usage.outputTokens;
	for (let i = calibration.entryIndex; i < entries.length; i++) {
		const messages = entries[i]!.messages;
		const from = i === calibration.entryIndex ? calibration.messageIndex + 1 : 0;
		for (let j = from; j < messages.length; j++)
			total += estimateTokens(messages[j]!);
	}
	return total;
}

export interface CutPoint {
	firstKeptEntryId: string;
	messagesToSummarize: Message[];
}

export interface CompactionPreparation extends CutPoint {
	tokensBefore: number;
}

// retained turn = 一条有效 assistant（非 error/aborted）+ 紧随其后的全部 toolResult。
// 候选只落在 assistant entry 上，因此 toolCall/toolResult 对不会被切开；
// 候选后的所有 entries 原样保留，parallel results 的顺序不影响切点。
function isRetainedTurnAssistant(message: Message): boolean {
	return message.role === "assistant" &&
		message.stopReason !== "error" && message.stopReason !== "aborted";
}

// 摘要输入是 model-visible conversation：system 始终完整重放，不进摘要。
function isConversationMessage(message: Message): boolean {
	return message.role !== "system";
}

export function findCutPoint(
	entries: readonly ProjectedSessionEntry[],
	keepRecentTurns: number,
): CutPoint | undefined {
	let seen = 0;
	let candidate = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.messages.some(isRetainedTurnAssistant)) {
			seen++;
			if (seen === keepRecentTurns) {
				candidate = i;
				break;
			}
		}
	}
	if (candidate < 0) return undefined;
	const messagesToSummarize: Message[] = [];
	for (const entry of entries.slice(0, candidate)) {
		for (const message of entry.messages) {
			if (isConversationMessage(message)) messagesToSummarize.push(message);
		}
	}
	if (messagesToSummarize.length === 0) return undefined;
	return { firstKeptEntryId: entries[candidate]!.source.id, messagesToSummarize };
}

export function prepareCompaction(
	projection: SessionContextProjection,
	keepRecentTurns: number,
): CompactionPreparation | undefined {
	const cut = findCutPoint(projection.entries, keepRecentTurns);
	if (!cut) return undefined;
	return { ...cut, tokensBefore: estimateContextTokens(projection) };
}

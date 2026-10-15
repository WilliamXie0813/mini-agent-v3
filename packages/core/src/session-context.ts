// 阶段 10：把当前祖先路径投影为模型上下文。journal 是 append-only 完整事实；
// 最新 compaction entry 在 firstKeptEntryId 前注入摘要，旧 conversation 留在文件里。
// branch 到压缩前的 entry 时投影自然恢复原文——这里没有任何可变状态。
import { getCurrentSystemMessage, getCurrentTools } from "@mini-agent/ai";
import type { Message, StreamContext } from "@mini-agent/ai";
import { createCompactionSummaryMessage } from "./compaction.ts";
import type {
	ProjectedSessionEntry,
	SessionContextProjection,
} from "./compaction.ts";
import type { SessionEntry, SessionEntryOf } from "./session-types.ts";

// submission 自身重建 user message，避免再次保存同一输入（阶段 9 规则）；
// tool_intent/update/outcome/run_end/compaction 是恢复元数据，不进 transcript。
function entryMessages(entry: SessionEntry): Message[] {
	if (entry.type === "submission")
		return [{ role: "user", content: [{ type: "text", text: entry.prompt }] }];
	if (entry.type === "message") return [entry.message];
	return [];
}

export function projectSessionContext(
	entries: readonly SessionEntry[],
): SessionContextProjection {
	// 只应用当前 path 上最后一个 compaction；旧 compaction 自身不再生成 summary。
	let latestIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "compaction") {
			latestIndex = i;
			break;
		}
	}
	if (latestIndex < 0) {
		// 保留空 messages 的 metadata 壳：entries 是 source 映射，
		// token 估算靠 source.id 定位 compaction 边界，不能把 run_end 丢掉。
		const projected = entries.map((source) => ({
			source,
			messages: entryMessages(source),
		}));
		return {
			entries: projected,
			messages: projected.flatMap((entry) => entry.messages),
		};
	}

	const compaction = entries[latestIndex] as SessionEntryOf<"compaction">;
	const cutIndex = entries.findIndex(
		(entry) => entry.id === compaction.firstKeptEntryId,
	);
	// journal append/open 已验证 firstKept 是 parent 的祖先；找不到说明文件被破坏。
	if (cutIndex < 0 || cutIndex >= latestIndex)
		throw new Error(
			`Compaction boundary not on path: ${compaction.firstKeptEntryId}`,
		);

	const summary: ProjectedSessionEntry = {
		source: compaction,
		messages: [createCompactionSummaryMessage(compaction.summary)],
	};
	const projected: ProjectedSessionEntry[] = [];
	for (let i = 0; i < entries.length; i++) {
		const source = entries[i]!;
		if (i === latestIndex) continue; // compaction metadata 不进 Message[]
		if (i === cutIndex) projected.push(summary);
		if (i < cutIndex) {
			// system 历史不参与摘要裁剪，始终按 path 顺序完整重放。
			projected.push({
				source,
				messages: entryMessages(source)
					.filter((message) => message.role === "system"),
			});
		} else {
			projected.push({ source, messages: entryMessages(source) });
		}
	}
	return {
		entries: projected,
		messages: projected.flatMap((entry) => entry.messages),
		latestCompaction: compaction,
	};
}

// Agent state 用：保留 provider 失败诊断（供审计与 UI 展示）。
export function messagesFromSessionPath(
	entries: readonly SessionEntry[],
): Message[] {
	return projectSessionContext(entries).messages;
}

// 模型请求用：overflow 诊断留在 journal 供审计，但不回喂模型——
// 否则每次请求都背着上一次失败现场，浪费窗口也干扰恢复。
export function streamContextFromSessionPath(
	entries: readonly SessionEntry[],
): StreamContext {
	const messages = projectSessionContext(entries).messages.filter(
		(message) =>
			!(message.role === "assistant" &&
				message.errorKind === "context_overflow"),
	);
	return {
		system: getCurrentSystemMessage(messages),
		messages,
		tools: getCurrentTools(messages),
	};
}

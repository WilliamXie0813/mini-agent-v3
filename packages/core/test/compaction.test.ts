import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, StopReason, Usage } from "@mini-agent/ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_CONTEXT_WINDOW,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	normalizeCompactionOptions,
	prepareCompaction,
	shouldCompact,
} from "../src/compaction.ts";
import type {
	CompactionSettings,
	ProjectedSessionEntry,
	SessionContextProjection,
} from "../src/compaction.ts";
import type { SessionEntry, SessionEntryOf } from "../src/session-types.ts";

describe("shouldCompact", () => {
	const settings: CompactionSettings = {
		enabled: true,
		reserveTokens: 20,
		keepRecentTurns: 2,
	};

	it("compacts only after crossing the reserved boundary", () => {
		// 严格大于：刚好顶到 reserve 边界不压缩，超过 1 token 才压缩。
		expect(shouldCompact(79, 100, settings)).toBe(false);
		expect(shouldCompact(80, 100, settings)).toBe(false);
		expect(shouldCompact(81, 100, settings)).toBe(true);
	});

	it("never compacts when disabled, however large the context", () => {
		expect(shouldCompact(1000, 100, { ...settings, enabled: false })).toBe(false);
	});
});

describe("normalizeCompactionOptions", () => {
	it("fills the planned defaults", () => {
		expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
		expect(DEFAULT_COMPACTION_SETTINGS).toEqual({
			enabled: true,
			reserveTokens: 16_384,
			keepRecentTurns: 4,
		});
		const normalized = normalizeCompactionOptions(undefined, undefined);
		expect(normalized.contextWindow).toBe(128_000);
		expect(normalized.settings).toEqual(DEFAULT_COMPACTION_SETTINGS);
	});

	it("merges partial settings over the defaults", () => {
		const normalized = normalizeCompactionOptions(1_000, { reserveTokens: 5 });
		expect(normalized).toEqual({
			contextWindow: 1_000,
			settings: { enabled: true, reserveTokens: 5, keepRecentTurns: 4 },
		});
	});

	it("rejects an invalid context window", () => {
		for (const value of [0, -1, 1.5, Number.NaN]) {
			expect(() => normalizeCompactionOptions(value, undefined))
				.toThrow(/contextWindow/);
		}
	});

	it("rejects a negative or window-sized reserve", () => {
		expect(() => normalizeCompactionOptions(100, { reserveTokens: -1 }))
			.toThrow(/reserveTokens/);
		expect(() => normalizeCompactionOptions(100, { reserveTokens: 100 }))
			.toThrow(/reserveTokens/);
		expect(() => normalizeCompactionOptions(100, { reserveTokens: 101 }))
			.toThrow(/reserveTokens/);
	});

	it("rejects zero or fractional keepRecentTurns", () => {
		expect(() => normalizeCompactionOptions(200_000, { keepRecentTurns: 0 }))
			.toThrow(/keepRecentTurns/);
		expect(() => normalizeCompactionOptions(200_000, { keepRecentTurns: 2.5 }))
			.toThrow(/keepRecentTurns/);
	});
});

// ── 测试数据构造：ProjectedSessionEntry 是 session-context.ts（Task 2）的产物，
// 这里手工构造同形状数据测纯函数。id 只需测试内部一致。
let entryCounter = 0;
function nextId(): string {
	entryCounter += 1;
	return `e${entryCounter}`;
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(
	text: string,
	extra: { stopReason?: StopReason; usage?: Usage } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		stopReason: extra.stopReason ?? "stop",
		...(extra.usage ? { usage: extra.usage } : {}),
	};
}

function messageEntry(message: Message): ProjectedSessionEntry {
	const source: SessionEntry = {
		id: nextId(), parentId: null, createdAt: "2026-10-15T00:00:00.000Z",
		type: "message", message,
	};
	return { source, messages: [message] };
}

function submissionEntry(prompt: string): ProjectedSessionEntry {
	const source: SessionEntry = {
		id: nextId(), parentId: null, createdAt: "2026-10-15T00:00:00.000Z",
		type: "submission", requestId: nextId(), prompt,
	};
	return { source, messages: [userMessage(prompt)] };
}

function project(
	entries: ProjectedSessionEntry[],
	latestCompaction?: SessionEntryOf<"compaction">,
): SessionContextProjection {
	return {
		entries,
		messages: entries.flatMap((entry) => entry.messages),
		...(latestCompaction ? { latestCompaction } : {}),
	};
}

describe("estimateTokens", () => {
	it("estimates text as ceil(chars / 4)", () => {
		expect(estimateTokens(userMessage("hello"))).toBe(2);
		expect(estimateTokens(userMessage("12345678"))).toBe(2);
		expect(estimateTokens(userMessage("123456789"))).toBe(3);
	});

	it("counts tool call name and serialized arguments", () => {
		const call: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }],
			stopReason: "toolUse",
		};
		// "read" (4) + '{"path":"x"}' (12) = 16 chars → 4 tokens。
		expect(estimateTokens(call)).toBe(4);
	});

	it("counts toolResult text", () => {
		const result: Message = {
			role: "toolResult", toolCallId: "c1", toolName: "read",
			content: [{ type: "text", text: "12345678" }], isError: false,
		};
		expect(estimateTokens(result)).toBe(2);
	});

	it("counts system sections and tool declarations", () => {
		const sectionsOnly: Message = {
			role: "system", sections: [{ text: "x".repeat(100) }],
		};
		expect(estimateTokens(sectionsOnly)).toBe(25);
		const withTools: Message = {
			role: "system",
			sections: [{ text: "x".repeat(100) }],
			toolsAdded: [{ name: "read", description: "read a file", parameters: {} }],
		};
		expect(estimateTokens(withTools)).toBeGreaterThan(25);
	});
});

describe("estimateContextTokens", () => {
	it("estimates every message when no usage exists", () => {
		const projection = project([
			submissionEntry("aaaa"), // 1
			messageEntry(assistantMessage("bbbbbbbb")), // 2
		]);
		expect(estimateContextTokens(projection)).toBe(3);
	});

	it("estimates messages and uses the latest valid usage without double counting cache", () => {
		const projection = project([
			messageEntry({ role: "system", sections: [{ text: "x".repeat(400) }] }),
			submissionEntry("old question"),
			messageEntry(assistantMessage("old answer", {
				usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 },
			})),
			submissionEntry("12345678"), // 8 chars → 2
		]);
		// 80 + 20 + 2 = 102：cache read/write 已含在 inputTokens 里，不再加（不是 142）；
		// 校准点之前的 system/user 也不重复估算。
		expect(estimateContextTokens(projection)).toBe(102);
	});

	it("skips error, aborted and zero-usage assistants as calibration points", () => {
		const good = messageEntry(assistantMessage("ok", {
			usage: { inputTokens: 80, outputTokens: 20 },
		}));
		const failed = messageEntry(assistantMessage("err", {
			stopReason: "error", usage: { inputTokens: 500, outputTokens: 0 },
		}));
		const aborted = messageEntry(assistantMessage("ab", {
			stopReason: "aborted", usage: { inputTokens: 500, outputTokens: 0 },
		}));
		const zero = messageEntry(assistantMessage("zero", {
			usage: { inputTokens: 0, outputTokens: 0 },
		}));
		const tail = submissionEntry("12345678");
		const projection = project([good, failed, aborted, zero, tail]);
		const expected = 100 +
			estimateTokens(failed.messages[0]!) +
			estimateTokens(aborted.messages[0]!) +
			estimateTokens(zero.messages[0]!) +
			estimateTokens(tail.messages[0]!);
		expect(estimateContextTokens(projection)).toBe(expected);
	});

	it("ignores usage recorded before the latest compaction", () => {
		const kept = messageEntry(assistantMessage("kept answer", {
			usage: { inputTokens: 9000, outputTokens: 100 },
		}));
		const compaction: SessionEntryOf<"compaction"> = {
			id: nextId(), parentId: kept.source.id, createdAt: "2026-10-15T00:00:00.000Z",
			type: "compaction", reason: "manual", summary: "s",
			firstKeptEntryId: kept.source.id, tokensBefore: 9999,
		};
		const summary: ProjectedSessionEntry = {
			source: compaction, messages: [userMessage("summary text")],
		};
		const after = submissionEntry("12345678");
		const projection = project([summary, kept, after], compaction);
		// kept 的 9000+100 usage 量的是压缩前的大上下文，必须整段回退到逐条粗估。
		const expected =
			estimateTokens(summary.messages[0]!) +
			estimateTokens(kept.messages[0]!) +
			estimateTokens(after.messages[0]!);
		expect(estimateContextTokens(projection)).toBe(expected);
	});

	it("trusts usage recorded after the latest compaction", () => {
		const kept = messageEntry(assistantMessage("kept answer", {
			usage: { inputTokens: 9000, outputTokens: 100 },
		}));
		const compaction: SessionEntryOf<"compaction"> = {
			id: nextId(), parentId: kept.source.id, createdAt: "2026-10-15T00:00:00.000Z",
			type: "compaction", reason: "manual", summary: "s",
			firstKeptEntryId: kept.source.id, tokensBefore: 9999,
		};
		const summary: ProjectedSessionEntry = {
			source: compaction, messages: [userMessage("summary text")],
		};
		const fresh = messageEntry(assistantMessage("fresh answer", {
			usage: { inputTokens: 50, outputTokens: 10 },
		}));
		const tail = submissionEntry("12345678"); // 2
		const projection = project([summary, kept, fresh, tail], compaction);
		expect(estimateContextTokens(projection)).toBe(62);
	});
});

// ── 切点测试数据：submission u1 / a1(toolCall) / intent·update·outcome / r1 /
// a2 / u2 / a3(toolCall×2) / r2 / r3 / a4，对应计划 Task 1 Step 9 的 logical entries。
function toolCallAssistant(callId: string, names: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: names.map((name, index) => ({
			type: "toolCall", id: `${callId}-${index}`, name, arguments: {},
		})),
		stopReason: "toolUse",
	};
}

function toolResultMessage(toolCallId: string, text: string): Message {
	return {
		role: "toolResult", toolCallId, toolName: "read",
		content: [{ type: "text", text }], isError: false,
	};
}

function metadataEntries(assistantEntryId: string): ProjectedSessionEntry[] {
	const createdAt = "2026-10-15T00:00:00.000Z";
	const intentId = nextId();
	const sources: SessionEntry[] = [
		{
			id: intentId, parentId: null, createdAt,
			type: "tool_intent", submissionId: "s1", assistantEntryId,
			toolCallId: "c1-0",
			tool: { name: "read", description: "read", parameters: {} },
			args: {}, replay: "safe", sourceIndex: 0,
		},
		{
			id: nextId(), parentId: null, createdAt,
			type: "tool_update", intentId,
			partialResult: { content: [{ type: "text", text: "partial" }] },
		},
		{
			id: nextId(), parentId: null, createdAt,
			type: "tool_outcome", intentId,
			result: { content: [{ type: "text", text: "done" }] }, isError: false,
		},
	];
	return sources.map((source) => ({ source, messages: [] }));
}

function buildToolConversation() {
	const u1 = submissionEntry("question one");
	const a1 = messageEntry(toolCallAssistant("c1", ["read"]));
	const meta = metadataEntries(a1.source.id);
	const r1 = messageEntry(toolResultMessage("c1-0", "file body"));
	const a2 = messageEntry(assistantMessage("answer one"));
	const u2 = submissionEntry("question two");
	const a3 = messageEntry(toolCallAssistant("c3", ["read", "read"]));
	const r2 = messageEntry(toolResultMessage("c3-0", "result two"));
	const r3 = messageEntry(toolResultMessage("c3-1", "result three"));
	const a4 = messageEntry(assistantMessage("answer two"));
	const entries = [u1, a1, ...meta, r1, a2, u2, a3, r2, r3, a4];
	return { entries, u1, a1, r1, a2, u2, a3, r2, r3, a4 };
}

describe("findCutPoint", () => {
	it("keeps recent assistant turns without cutting tool results", () => {
		const { entries, u1, a1, r1, a2, u2, a3 } = buildToolConversation();
		const cut = findCutPoint(entries, 2);
		// 第 2 条 retained turn 是 a3，绝不是它后面的 r2/r3——
		// toolCall 与 toolResult 必须同进同出，否则模型看到没有结果的调用。
		expect(cut?.firstKeptEntryId).toBe(a3.source.id);
		expect(cut?.messagesToSummarize).toEqual([
			u1.messages[0]!, a1.messages[0]!, r1.messages[0]!,
			a2.messages[0]!, u2.messages[0]!,
		]);
	});

	it("keeps every tool result after the cut regardless of outcome order", () => {
		const { entries, a3, r2, r3 } = buildToolConversation();
		const reordered = entries.map((entry) =>
			entry === r2 ? r3 : entry === r3 ? r2 : entry);
		const cut = findCutPoint(reordered, 2);
		expect(cut?.firstKeptEntryId).toBe(a3.source.id);
	});

	it("does not count error or aborted assistants as retained turns", () => {
		const { entries, a2, a3 } = buildToolConversation();
		const failed = messageEntry(assistantMessage("boom", { stopReason: "error" }));
		const withTail = [...entries, failed];
		// 尾部 error 不占 turn 数：keep=2 仍切在 a3。
		expect(findCutPoint(withTail, 2)?.firstKeptEntryId).toBe(a3.source.id);
		// error 之后 keep=3：a4/a3/a2 是全部有效 turn，切在 a2。
		expect(findCutPoint(withTail, 3)?.firstKeptEntryId).toBe(a2.source.id);
	});

	it("returns undefined when fewer valid turns exist than requested", () => {
		const { entries } = buildToolConversation();
		expect(findCutPoint(entries, 5)).toBeUndefined();
		expect(findCutPoint(entries.slice(0, 2), 2)).toBeUndefined();
	});

	it("returns undefined when nothing summarizable precedes the cut", () => {
		const system: ProjectedSessionEntry = {
			source: {
				id: nextId(), parentId: null, createdAt: "2026-10-15T00:00:00.000Z",
				type: "message",
				message: { role: "system", sections: [{ text: "base" }] },
			},
			messages: [{ role: "system", sections: [{ text: "base" }] }],
		};
		const a1 = messageEntry(assistantMessage("one"));
		const a2 = messageEntry(assistantMessage("two"));
		// 候选 a1 之前只有 system——system 不参与摘要，无可摘要前缀。
		expect(findCutPoint([system, a1, a2], 2)).toBeUndefined();
	});
});

describe("prepareCompaction", () => {
	it("combines the cut point with the current token estimate", () => {
		const { entries, a3 } = buildToolConversation();
		const projection = project(entries);
		const preparation = prepareCompaction(projection, 2);
		expect(preparation?.firstKeptEntryId).toBe(a3.source.id);
		expect(preparation?.tokensBefore).toBe(estimateContextTokens(projection));
	});

	it("returns undefined when no cut point exists", () => {
		expect(prepareCompaction(project([messageEntry(assistantMessage("only"))]), 4))
			.toBeUndefined();
	});
});

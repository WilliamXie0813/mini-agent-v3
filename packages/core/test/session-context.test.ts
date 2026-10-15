import { describe, expect, it } from "vitest";
import { getCurrentSystemMessage, getCurrentTools } from "@mini-agent/ai";
import type { AssistantMessage, Message, Tool } from "@mini-agent/ai";
import { createCompactionSummaryMessage } from "../src/compaction.ts";
import {
	messagesFromSessionPath,
	projectSessionContext,
	streamContextFromSessionPath,
} from "../src/session-context.ts";
import type {
	SessionEntry,
	SessionEntryBase,
} from "../src/session-types.ts";

// 手工构造带 parent 链的 path（pathTo 的产物形状）。id 只需测试内部一致。
let counter = 0;

type TestEntryData =
	| { type: "submission"; requestId: string; prompt: string }
	| { type: "message"; message: Message }
	| {
			type: "compaction";
			reason: "manual" | "threshold" | "overflow";
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
	  };

function base<TData extends TestEntryData>(
	data: TData,
	parent: SessionEntry | null,
): SessionEntryBase & TData {
	counter += 1;
	return {
		...data,
		id: `e${counter}`,
		parentId: parent?.id ?? null,
		createdAt: "2026-10-15T00:00:00.000Z",
	};
}

const readTool: Tool = { name: "read", description: "read a file", parameters: {} };

function systemEntry(
	text: string,
	parent: SessionEntry | null,
	toolsAdded?: Tool[],
) {
	const message: Message = {
		role: "system",
		sections: [{ text }],
		...(toolsAdded ? { toolsAdded } : {}),
	};
	return base({ type: "message" as const, message }, parent);
}

function submissionEntry(prompt: string, parent: SessionEntry | null) {
	return base(
		{ type: "submission" as const, requestId: `r-${prompt}`, prompt },
		parent,
	);
}

function assistantEntry(
	text: string,
	parent: SessionEntry | null,
	extra: Partial<AssistantMessage> = {},
) {
	const message: Message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...extra,
	};
	return base({ type: "message" as const, message }, parent);
}

function compactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parent: SessionEntry,
) {
	return base({
		type: "compaction" as const,
		reason: "manual" as const,
		summary,
		firstKeptEntryId,
		tokensBefore: 120_000,
	}, parent);
}

function conversationTexts(messages: Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "system"
			? []
			: message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
	);
}

const SUMMARY_WRAPPER =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>";

// system(base) → u1 → a1 → system(policy) → u2 → a2 → u3 → a3 → C(firstKept=a2) → u4 → a4
function buildCompactedPath() {
	const sys1 = systemEntry("base", null, [readTool]);
	const u1 = submissionEntry("u1", sys1);
	const a1 = assistantEntry("a1", u1);
	const sys2 = systemEntry("policy update", a1);
	const u2 = submissionEntry("u2", sys2);
	const a2 = assistantEntry("a2", u2);
	const u3 = submissionEntry("u3", a2);
	const a3 = assistantEntry("a3", u3);
	const compact = compactionEntry("summary of u1..u2", a2.id, a3);
	const u4 = submissionEntry("u4", compact);
	const a4 = assistantEntry("a4", u4);
	const path: SessionEntry[] = [sys1, u1, a1, sys2, u2, a2, u3, a3, compact, u4, a4];
	return { path, sys1, sys2, a2, compact, a4 };
}

describe("projectSessionContext", () => {
	it("projects the summary before the kept tail and preserves system history", () => {
		const { path, a2, compact } = buildCompactedPath();
		const projection = projectSessionContext(path);

		// system sections 与工具声明完整重放，与未压缩时逐字段相等。
		const raw = projectSessionContext(path.slice(0, 8));
		expect(getCurrentSystemMessage(projection.messages))
			.toEqual(getCurrentSystemMessage(raw.messages));
		expect(getCurrentTools(projection.messages))
			.toEqual(getCurrentTools(raw.messages));

		// conversation = summary + K..C.parent + C 之后；u1/a1/u2 不再出现。
		expect(conversationTexts(projection.messages)).toEqual([
			`${SUMMARY_WRAPPER}\nsummary of u1..u2\n</summary>`,
			"a2",
			"u3",
			"a3",
			"u4",
			"a4",
		]);

		// synthetic summary 的 source 是 compaction entry，供 token 估算定位边界。
		expect(projection.latestCompaction).toEqual(compact);
		const summaryEntry = projection.entries.find(
			(entry) => entry.source.type === "compaction",
		);
		expect(summaryEntry?.messages).toEqual([
			createCompactionSummaryMessage("summary of u1..u2"),
		]);
		// first-kept 仍是 a2 自己的 entry，summary 插在它前面。
		const keptIndex = projection.entries.findIndex(
			(entry) => entry.source.id === a2.id,
		);
		expect(keptIndex).toBeGreaterThan(0);
		expect(projection.entries[keptIndex - 1]?.source.type).toBe("compaction");
	});

	it("uses only the latest compaction and branches back to raw history", () => {
		const { path, compact, a4: lastOfFirstBranch } = buildCompactedPath();
		// 继续：u5 → a5 → u6 → a6 → C2(firstKept=a5)
		const u5 = submissionEntry("u5", lastOfFirstBranch);
		const a5 = assistantEntry("a5", u5);
		const u6 = submissionEntry("u6", a5);
		const a6 = assistantEntry("a6", u6);
		const compact2 = compactionEntry("second summary", a5.id, a6);
		const twicePath: SessionEntry[] = [...path, u5, a5, u6, a6, compact2];

		// 1. 第二次压缩后只有第二份摘要；第一份摘要是第二次摘要的输入，
		//    不并列进入最终 context（它在 K2 之前已被丢弃）。
		const twice = projectSessionContext(twicePath);
		expect(twice.latestCompaction?.summary).toBe("second summary");
		expect(conversationTexts(twice.messages)).toEqual([
			`${SUMMARY_WRAPPER}\nsecond summary\n</summary>`,
			"a5",
			"u6",
			"a6",
		]);
		expect(conversationTexts(twice.messages).join(" "))
			.not.toContain("summary of u1..u2");

		// 2. branch 到第一次压缩前：无摘要，原始 conversation 完整恢复。
		const beforeCompact = projectSessionContext(path.slice(0, 8));
		expect(beforeCompact.latestCompaction).toBeUndefined();
		expect(conversationTexts(beforeCompact.messages)).toEqual([
			"u1", "a1", "u2", "a2", "u3", "a3",
		]);

		// 3. branch 到两次压缩之间：只应用第一份摘要。
		const between = projectSessionContext(path);
		expect(between.latestCompaction?.id).toBe(compact.id);
		expect(conversationTexts(between.messages)).toEqual([
			`${SUMMARY_WRAPPER}\nsummary of u1..u2\n</summary>`,
			"a2",
			"u3",
			"a3",
			"u4",
			"a4",
		]);
	});
});

describe("session path contexts", () => {
	it("keeps overflow diagnostics in state but out of the stream context", () => {
		const sys1 = systemEntry("base", null, [readTool]);
		const u1 = submissionEntry("u1", sys1);
		const overflow = assistantEntry("", u1, {
			stopReason: "error",
			errorKind: "context_overflow",
			errorMessage: "prompt is too long",
		});
		const path: SessionEntry[] = [sys1, u1, overflow];

		// state/audit 保留 diagnostic；模型上下文排除它。
		expect(messagesFromSessionPath(path)).toHaveLength(3);
		const context = streamContextFromSessionPath(path);
		expect(context.messages).toHaveLength(2);
		expect(context.messages.some((message) =>
			message.role === "assistant" && message.errorKind === "context_overflow"
		)).toBe(false);
		// system 与 tools 从完整 system/tool 历史重算。
		expect(context.system.sections).toEqual([{ text: "base" }]);
		expect(context.tools).toEqual([readTool]);
	});

	it("matches stage 9 behavior when no compaction exists", () => {
		const sys1 = systemEntry("base", null, [readTool]);
		const u1 = submissionEntry("hello", sys1);
		const a1 = assistantEntry("hi", u1);
		const path: SessionEntry[] = [sys1, u1, a1];
		expect(messagesFromSessionPath(path)).toEqual([
			sys1.message,
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			a1.message,
		]);
	});
});

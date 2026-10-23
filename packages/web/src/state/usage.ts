import type { SessionViewState, Usage, UsageTotals } from "./types.ts";

// 只累计 AssistantMessage.usage 的四个计数；没有 usage 的消息不贡献任何字段。
// durable 取 journal assistant entries，live 只取 message_end——
// message_update partial、turn_end.message、agent_end.messages 都是同一条
// 消息的重复载体，snapshot seam 保证 durable 与 live 不重叠。
export function buildUsageTotals(session: SessionViewState): UsageTotals {
	const totals: UsageTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const entry of session.entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(totals, entry.message.usage);
		}
	}
	for (const envelope of session.events) {
		const event = envelope.event;
		if (event.type === "message_end" && event.message.role === "assistant") {
			add(totals, event.message.usage);
		}
	}
	return totals;
}

function add(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.inputTokens += usage.inputTokens;
	totals.outputTokens += usage.outputTokens;
	totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
	totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
}

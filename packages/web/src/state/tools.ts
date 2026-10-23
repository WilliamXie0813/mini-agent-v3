import type {
	AgentEventEnvelope,
	AssistantMessage,
	SessionEntry,
	SessionViewState,
	ToolCardView,
} from "./types.ts";

interface CardContext {
	cards: Map<string, ToolCardView>;
	order: string[];
	intentToCall: Map<string, string>;
}

// tool card identity 永远是 toolCallId；顺序取 assistant 消息里 toolCall block
// 的源顺序（durable entries 先于 live events），执行事实合并进同一张卡。
export function buildToolCards(session: SessionViewState): ToolCardView[] {
	const context: CardContext = {
		cards: new Map(),
		order: [],
		intentToCall: new Map(),
	};
	for (const entry of session.entries) applyEntry(context, entry);
	for (const envelope of session.events) applyEvent(context, envelope);
	return context.order.map((toolCallId) => {
		const card = context.cards.get(toolCallId);
		if (!card) throw new Error(`missing tool card: ${toolCallId}`);
		return card;
	});
}

function ensureCard(
	context: CardContext,
	toolCallId: string,
	source: { toolName: string; args: unknown; sourceIndex: number },
): ToolCardView {
	const existing = context.cards.get(toolCallId);
	if (existing) return existing;
	const card: ToolCardView = {
		id: `tool:${toolCallId}`,
		toolCallId,
		toolName: source.toolName,
		sourceIndex: source.sourceIndex,
		status: "pending",
		args: source.args,
	};
	context.cards.set(toolCallId, card);
	context.order.push(toolCallId);
	return card;
}

function appendBlocks(
	context: CardContext,
	content: AssistantMessage["content"],
): void {
	let sourceIndex = 0;
	for (const block of content) {
		if (block.type !== "toolCall") continue;
		ensureCard(context, block.id, {
			toolName: block.name,
			args: block.arguments,
			sourceIndex,
		});
		sourceIndex += 1;
	}
}

function applyEntry(context: CardContext, entry: SessionEntry): void {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") {
			appendBlocks(context, entry.message.content);
		} else if (entry.message.role === "toolResult") {
			const card = context.cards.get(entry.message.toolCallId);
			if (!card) return;
			if (card.result === undefined) card.result = entry.message.content;
			if (card.isError === undefined) card.isError = entry.message.isError;
			if (card.status === "pending" || card.status === "running") {
				card.status = entry.message.isError ? "error" : "completed";
			}
		}
		return;
	}
	if (entry.type === "tool_intent") {
		context.intentToCall.set(entry.id, entry.toolCallId);
		const card = ensureCard(context, entry.toolCallId, {
			toolName: entry.tool.name,
			args: entry.args,
			sourceIndex: entry.sourceIndex,
		});
		if (card.status === "pending") card.status = "running";
		return;
	}
	if (entry.type === "tool_update") {
		const card = cardForIntent(context, entry.intentId);
		if (card) card.partialResult = entry.partialResult;
		return;
	}
	if (entry.type === "tool_outcome") {
		const card = cardForIntent(context, entry.intentId);
		if (!card) return;
		card.result = entry.result;
		card.isError = entry.isError;
		if (entry.durationMs !== undefined) card.durationMs = entry.durationMs;
		card.status = entry.isError ? "error" : "completed";
	}
}

function cardForIntent(
	context: CardContext,
	intentId: string,
): ToolCardView | undefined {
	const toolCallId = context.intentToCall.get(intentId);
	return toolCallId ? context.cards.get(toolCallId) : undefined;
}

function applyEvent(context: CardContext, envelope: AgentEventEnvelope): void {
	const event = envelope.event;
	if (
		(event.type === "message_start" ||
			event.type === "message_update" ||
			event.type === "message_end") &&
		event.message.role === "assistant"
	) {
		appendBlocks(context, event.message.content);
		return;
	}
	if (event.type === "tool_execution_start") {
		const card = ensureCard(context, event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			sourceIndex: context.order.length,
		});
		if (card.status === "pending") card.status = "running";
		return;
	}
	if (event.type === "tool_execution_update") {
		const card = context.cards.get(event.toolCallId);
		if (card) card.partialResult = event.partialResult;
		return;
	}
	if (event.type === "tool_execution_end") {
		const card = ensureCard(context, event.toolCallId, {
			toolName: event.toolName,
			args: {},
			sourceIndex: context.order.length,
		});
		card.result = event.result;
		card.isError = event.isError;
		if (event.durationMs !== undefined) card.durationMs = event.durationMs;
		card.status = event.isError ? "error" : "completed";
	}
}

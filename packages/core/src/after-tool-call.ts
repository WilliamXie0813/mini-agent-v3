import type { AfterToolCall, AfterToolCallContext } from "./agent-options.ts";
import type { FinalizedToolCallOutcome } from "./finalize-tool-call.ts";

// 决策 hook：只允许覆盖 content 与 isError。重建而不是就地改——
// message.content 与 result.content 必须指向同一个新数组，
// 否则 emitToolEnd 与 emitToolResultMessage 会各自报出不同内容。
// durationMs 与 terminate 不进返回对象：{...outcome} 展开保留原值。
export async function applyAfterToolCall(
	outcome: FinalizedToolCallOutcome,
	hook: AfterToolCall | undefined,
	context: AfterToolCallContext,
	signal?: AbortSignal,
): Promise<FinalizedToolCallOutcome> {
	if (!hook) return outcome;
	const override = signal === undefined
		? await hook(context)
		: await hook(context, signal);
	if (!override) return outcome;
	const content = override.content ?? outcome.result.content;
	const isError = override.isError ?? outcome.isError;
	return {
		...outcome,
		isError,
		result: { ...outcome.result, content, isError },
		message: { ...outcome.message, content, isError },
	};
}

import type {
	AssistantMessage,
	AssistantMessageEvent,
	StreamContext,
} from "./types.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";

// 依赖注入缝：core 完全不知道 provider 存在（spec §3.2a）。
// 返回事件流而不是 AsyncGenerator：provider 是推送源（阶段 7 的 SSE socket
// 按自己的节奏吐字节），拉模型要求消费者先伸手才继续，字节没地方放。
export type StreamFn = (
	context: StreamContext,
	signal?: AbortSignal,
) => AssistantMessageEventStream;

let defaultStreamFn: StreamFn | undefined;

// 供组装方（cli）安装默认实现；传 undefined 即清除。
export function setDefaultStreamFn(fn: StreamFn | undefined): void {
	defaultStreamFn = fn;
}

export function getDefaultStreamFn(): StreamFn {
	if (defaultStreamFn === undefined) {
		throw new Error(
			"no default stream fn installed; call setDefaultStreamFn() at composition root",
		);
	}
	return defaultStreamFn;
}

export type AssistantMessageEventHandler = (
	event: AssistantMessageEvent,
) => void | Promise<void>;

// 事件消费的唯一实现：delta 交给 UI 即时显示，done 携带的消息是唯一进历史的候选。
// 放在 ai 而不是 core，因为它是「事件协议怎么读」的知识，与 provider 同侧；
// core 只负责决定拿到的消息要不要入历史。
export async function consumeAssistantMessage(
	stream: AssistantMessageEventStream,
	onEvent?: AssistantMessageEventHandler,
): Promise<AssistantMessage> {
	let done: AssistantMessage | undefined;
	for await (const event of stream) {
		await onEvent?.(event);
		if (event.type === "done") {
			done = event.message;
		}
	}
	// 契约违反：provider 结束流却没发 done。没有这条，result() 会永远挂着，
	// 排查成本是「终端不动，什么都没有」。
	if (done === undefined)
		throw new Error("assistant stream ended without a done event");
	return done;
}

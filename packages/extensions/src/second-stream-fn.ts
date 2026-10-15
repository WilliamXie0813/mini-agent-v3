import { createAssistantMessageEventStream } from "@mini-agent/ai";
import type { AssistantMessage } from "@mini-agent/ai";
import type { AssistantMessageEventStream } from "@mini-agent/ai";
import type { StreamContext } from "@mini-agent/ai";
import type { StreamFn } from "@mini-agent/ai";

// spec §3.2(a) 的验证物：StreamFn 是「普通函数类型 + 模块级装配槽」，
// 所以写第二个实现换 provider/装饰链路不需要改 core 一行。
// 本实现的职责是装饰与观测，不是第二个 HTTP 客户端——SSE 解析仍归 provider 同侧。
export interface StreamCallRecord {
	// 报告的是装饰前的 context——否则「扩展改了什么」在观测日志里看不出来。
	context: StreamContext;
	durationMs: number;
	// ok = 转发出去的最终消息 stopReason 不是 "error"。
	ok: boolean;
}

export interface SecondStreamFnOptions {
	// 同步或异步改写交给内层 StreamFn 的 context；签名的第二个参数是调用方的 abort signal。
	decorate?: (
		context: StreamContext,
		signal?: AbortSignal,
	) => StreamContext | Promise<StreamContext>;
	// 转发循环结束时按最终结果回调一次。
	onCall?: (record: StreamCallRecord) => void;
}

// 返回类型是 AssistantMessageEventStream（同步签名）：异步 decorate 只能在拿到
// stream 之后通过事件管道转发，把耗时与 ok 记进去。
export function createSecondStreamFn(
	inner: StreamFn,
	options: SecondStreamFnOptions = {},
): StreamFn {
	return (context, signal) => {
		const startedAt = performance.now();
		const decorate = options.decorate;
		const stream = decorate
			? decorateThen(inner, context, signal, decorate, options.onCall, startedAt)
			: track(inner(context, signal), context, options.onCall, startedAt);
		return stream;
	};
}

// decorate 存在：先建转发流，decorate 完成后再调用 inner 并转发其事件。
// 异步任务的 rejection 转成 error 事件投进转发流——StreamFn 契约不抛异常。
function decorateThen(
	inner: StreamFn,
	context: StreamContext,
	signal: AbortSignal | undefined,
	decorate: NonNullable<SecondStreamFnOptions["decorate"]>,
	onCall: SecondStreamFnOptions["onCall"],
	startedAt: number,
): AssistantMessageEventStream {
	const forward = createAssistantMessageEventStream();
	void (async () => {
		const decorated = await decorate(context, signal);
		await forwardAndRecord(inner(decorated, signal), forward, context, onCall, startedAt);
	})().catch((error: unknown) => {
		pushFailure(forward, error);
	});
	return forward;
}

// decorate 不存在：直接调 inner，用一个包装的异步循环转发事件并记录 onCall。
// 转发不可省——EventStream 的队列只能有一个消费者 drain，观测 done 与返回原流互斥。
function track(
	source: AssistantMessageEventStream,
	context: StreamContext,
	onCall: SecondStreamFnOptions["onCall"],
	startedAt: number,
): AssistantMessageEventStream {
	const forward = createAssistantMessageEventStream();
	void forwardAndRecord(source, forward, context, onCall, startedAt).catch(
		(error: unknown) => {
			pushFailure(forward, error);
		},
	);
	return forward;
}

async function forwardAndRecord(
	source: AssistantMessageEventStream,
	forward: AssistantMessageEventStream,
	context: StreamContext,
	onCall: SecondStreamFnOptions["onCall"],
	startedAt: number,
): Promise<void> {
	let outcome: AssistantMessage | undefined;
	for await (const event of source) {
		if (event.type === "done") outcome = event.message;
		if (event.type === "error") outcome = event.error;
		forward.push(event);
	}
	onCall?.({
		context,
		durationMs: performance.now() - startedAt,
		ok: outcome !== undefined && outcome.stopReason !== "error",
	});
	forward.end();
}

// decorate 的 rejection（或转发循环的异常）变成流上的 error 终止事件，
// 而不是 unhandled rejection——StreamFn 的失败编码在 stopReason: "error" 里。
function pushFailure(
	forward: AssistantMessageEventStream,
	error: unknown,
): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
	};
	forward.push({ type: "error", reason: "error", error: message });
	forward.end(message);
}

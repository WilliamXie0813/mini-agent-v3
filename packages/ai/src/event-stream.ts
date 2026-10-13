import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

// 摊还 O(1) 的 FIFO：enqueue 推入 incoming，dequeue 在 outgoing 空时把 incoming 整体倒过来再 pop。
// 同一个结构承载「事件队列」与「等待者队列」两种用途（Pi event-stream.ts:3-23 原样）。
class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// 推模型的事件流：provider 按自己的节奏 push（阶段 7 的 SSE socket 不等消费者），
// 消费者 for await 读队列；result() 是与迭代并行的第二个出口，拿到权威结果。
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	protected done = false;
	// settled 只记录「isComplete 触发过」——end(result) 的显式 resolve 不算契约完成。
	private settled = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: Error) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R,
	) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		// 预挂 noop catch：end() 的契约兜底会 reject 这个 promise，但调用方未必 await result()
		// （循环用 done 事件而不是 result()）。不预挂就是 unhandled rejection 噪音；
		// 挂了之后 await result() 的人照样拿到 rejection——「已处理」是 promise 的标记，不是吞掉。
		this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.settled = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// 有等待者直接交付，否则入队——消费者什么时候来读都行。
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		// 契约违反兜底：isComplete 从未触发（provider 没发 done 就结束）时，
		// result() 不能永远挂着——那是一个没有栈、没有错误的死锁。
		if (!this.settled)
			this.rejectFinalResult(
				new Error("event stream ended without a completion event"),
			);
		this.done = true;
		if (result !== undefined) this.resolveFinalResult(result);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as never, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) =>
					this.waiting.enqueue(resolve),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

// 一次 assistant 响应的事件流，兼职计时：done 消息带上 durationMs，
// 用单调时钟从流创建那一刻起算，除非消息自己已经测过（provider 自己测的就以它为准）。
// Pi 还有一条「timestamp 早于流创建则不计时」的守卫——那是给「转发别处开始的响应」用的，
// v3 的 AssistantMessage 没有 timestamp 字段、也没有 deferred 响应（阶段 7 才出现），故不抄。
export class AssistantMessageEventStream extends EventStream<
	AssistantMessageEvent,
	AssistantMessage
> {
	readonly #startedAtMonotonic = performance.now();

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		if (event.type === "error") this.#time(event.error);
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}

	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined) return;
		message.durationMs = Math.max(
			0,
			Math.round(performance.now() - this.#startedAtMonotonic),
		);
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}

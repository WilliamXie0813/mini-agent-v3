import { setTimeout } from "node:timers/promises";
import type { AssistantMessage, ContentBlock, StopReason } from "./types.ts";
import type { StreamFn } from "./stream-fn.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";

// 确定性假模型：阶段 1-6 的默认 provider，与阶段 7 的 anthropic.ts 同层同契约。
// 不是"随机返回文本"，而是从预设脚本表按被调用次数索引取条目——
// 测试因此完全确定；脚本耗尽后复用最后一条（可预测，而不是返回 undefined 让下游炸）。

// 脚本项既可以是一句话，也可以是一整条 content 数组（含 toolCall），
// 还可以显式声明 stopReason——provider 能报的六种（如 length）脚本必须能表达，
// 否则 core 的 length 保护分支在测试里无从触发。
export type FakeStep =
	string | ContentBlock[] | { content: ContentBlock[]; stopReason: StopReason };

// stopReason 的判据是「有没有要求模型停下」——只要有一条 toolCall，模型就是在等工具结果，
// 按 provider 契约报 toolUse；否则报 stop。core 不自行推断这件事。
function stopReasonFor(content: ContentBlock[]): "stop" | "toolUse" {
	return content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
}

// 数组项浅拷贝：消息会被推进历史，同一条脚本被多次消费时不能共享同一个数组对象。
function normalize(step: FakeStep): {
	content: ContentBlock[];
	stopReason?: StopReason;
} {
	if (typeof step === "string")
		return { content: [{ type: "text", text: step }] };
	if (Array.isArray(step)) return { content: step.map((c) => ({ ...c })) };
	return {
		content: step.content.map((c) => ({ ...c })),
		stopReason: step.stopReason,
	};
}

export interface FakeStreamOptions {
	// 每个 delta 的字符数。缺省 1：CLI 的「逐字出现」（验收 #1）是默认行为，
	// 不是需要在组装点记得打开的开关。测试想要短事件序列就显式传大值。
	chunkSize?: number;
	// 每个 delta 之间的等待。缺省 0：测试不应该是慢的。
	delayMs?: number;
}

// 按固定宽度切片。空文本返回 [""] 而不是 []——空串必须也走一遍 delta，
// 否则「start 之后直接 done」和「流坏了」在事件序列上无法区分。
function splitIntoDeltas(text: string, chunkSize: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkSize) {
		chunks.push(text.slice(index, index + chunkSize));
	}
	return chunks.length > 0 ? chunks : [""];
}

export function createFakeStreamFn(
	script: FakeStep[],
	options: FakeStreamOptions = {},
): StreamFn {
	const chunkSize = options.chunkSize ?? 1;
	const delayMs = options.delayMs ?? 0;
	// 在调用点就校验：splitIntoDeltas 跑在微任务里，那里的 throw 只是 unhandled rejection，
	// 调用方拿不到。chunkSize < 1 会让 slice 原地踏步，无限循环。
	if (chunkSize < 1)
		throw new Error(`chunkSize must be >= 1, got ${chunkSize}`);
	let callIndex = 0;
	return (_context, signal) => {
		const stream = createAssistantMessageEventStream();
		// 生产跑在自己的微任务里，函数立刻返回 stream——与 Pi 的 faux.ts:523 同构。
		// 消费者的 for await 因此是在「流已经可能有一批事件了」之后才开始读的，
		// 这正是 EventStream 的队列存在的原因。
		queueMicrotask(async () => {
			const partial: AssistantMessage = {
				role: "assistant", content: [], stopReason: "pending",
			};
			stream.push({ type: "start", partial: { ...partial } });
			try {
				signal?.throwIfAborted();
				const step = script[Math.min(callIndex, script.length - 1)];
				callIndex++;
				const { content, stopReason } = normalize(step);
				for (let index = 0; index < content.length; index++) {
					const block = content[index];
					// 工具调用块本阶段不分片（toolcall_delta 是阶段 7 的）。
					if (block.type !== "text") {
						partial.content = [...partial.content, { ...block }];
						continue;
					}
					partial.content = [...partial.content, { type: "text", text: "" }];
					for (const chunk of splitIntoDeltas(block.text, chunkSize)) {
						if (delayMs > 0) await setTimeout(delayMs, undefined, { signal });
						signal?.throwIfAborted();
						const target = partial.content[index];
						if (target.type === "text") target.text += chunk;
						stream.push({
							type: "text_delta",
							contentIndex: index,
							delta: chunk,
							partial: { ...partial },
						});
					}
				}
				// stopReason "pending" 不能出现在 done 里——它是「还没开始」的占位值。
				// 优先级是「脚本项显式声明 > 按 content 推导」：length 场景里 content 仍是
				// toolCall（半截 JSON 被尽力解析出来），推导会得出 toolUse，是错的。
				const message: AssistantMessage = {
					role: "assistant",
					content,
					stopReason: stopReason ?? stopReasonFor(content),
				};
				stream.push({ type: "done", message });
				stream.end(message);
			} catch (error) {
				const reason = signal?.aborted ? "aborted" : "error";
				stream.push({ type: "error", reason, error: {
					role: "assistant", content: [], stopReason: reason,
					errorMessage: reason === "aborted" ? "Operation aborted"
						: error instanceof Error ? error.message : String(error),
				} });
			} finally {
				stream.end();
			}
		});
		return stream;
	};
}

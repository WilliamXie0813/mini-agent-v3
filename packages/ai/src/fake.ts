import type { AssistantMessage, ContentBlock, StreamContext } from "./types.ts";
import type { StreamFn } from "./stream-fn.ts";

// 确定性假模型：阶段 1-6 的默认 provider，与阶段 7 的 anthropic.ts 同层同契约。
// 不是"随机返回文本"，而是从预设脚本表按被调用次数索引取条目——
// 测试因此完全确定；脚本耗尽后复用最后一条（可预测，而不是返回 undefined 让下游炸）。

// 脚本项既可以是一句话，也可以是一整条 content 数组（含 toolCall）。
export type FakeStep = string | ContentBlock[];

// stopReason 的判据是「有没有要求模型停下」——只要有一条 toolCall，模型就是在等工具结果，
// 按 provider 契约报 toolUse；否则报 stop。core 不自行推断这件事。
function stopReasonFor(content: ContentBlock[]): "stop" | "toolUse" {
	return content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
}

// 数组项浅拷贝：消息会被推进历史，同一条脚本被多次消费时不能共享同一个数组对象。
function normalize(step: FakeStep): ContentBlock[] {
	return typeof step === "string" ? [{ type: "text", text: step }] : step.map((c) => ({ ...c }));
}

export function createFakeStreamFn(script: FakeStep[]): StreamFn {
	let callIndex = 0;
	return async function* (_context: StreamContext, _signal?: AbortSignal) {
		const text = script[Math.min(callIndex, script.length - 1)];
		callIndex++;
		const content = normalize(text);
		const message: AssistantMessage = { role: "assistant", content, stopReason: stopReasonFor(content) };
		yield { type: "start", message };
		yield { type: "done", message };
	};
}

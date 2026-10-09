import type { AssistantMessage, StreamContext } from "./types.ts";
import type { StreamFn } from "./stream-fn.ts";

// 确定性假模型：阶段 1-6 的默认 provider，与阶段 7 的 anthropic.ts 同层同契约。
// 不是"随机返回文本"，而是从预设脚本表按被调用次数索引取条目——
// 测试因此完全确定；脚本耗尽后复用最后一条（可预测，而不是返回 undefined 让下游炸）。
export function createFakeStreamFn(script: string[]): StreamFn {
	let callIndex = 0;
	return async function* (_context: StreamContext, _signal?: AbortSignal) {
		const text = script[Math.min(callIndex, script.length - 1)];
		callIndex++;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
		};
		yield { type: "start", message };
		yield { type: "done", message };
	};
}

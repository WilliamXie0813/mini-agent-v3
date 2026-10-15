// 阶段 10：Anthropic/Kimi 错误的结构化分类。超窗识别只许活在 provider 层——
// core 禁止匹配错误字符串，只看 AssistantMessage.errorKind。
import type { AssistantErrorKind } from "./types.ts";

export interface AnthropicErrorClassification {
	kind: AssistantErrorKind;
	diagnostic: string;
}

// 已知超窗信号：invalid_request_error + 超窗短语。其他一切（overloaded、500、
// 普通参数错误）都是 provider——误判为超窗会让 core 白做一次压缩重试。
const CONTEXT_OVERFLOW_MESSAGE =
	/prompt is too long|context window|context length|too many tokens|maximum context/i;

export function classifyAnthropicError(
	type: string,
	message: string,
): AnthropicErrorClassification {
	const kind: AssistantErrorKind =
		type === "invalid_request_error" && CONTEXT_OVERFLOW_MESSAGE.test(message)
			? "context_overflow"
			: "provider";
	return { kind, diagnostic: `${type}: ${message}` };
}

// 非 2xx：解析有限诊断 body；body 不是已知 JSON 形状时落到通用 HTTP 错误。
export function classifyHttpError(
	status: number,
	body: string,
): AnthropicErrorClassification {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const error = (parsed as { error?: unknown }).error;
			if (error !== null && typeof error === "object" && !Array.isArray(error)) {
				const { type, message } = error as { type?: unknown; message?: unknown };
				if (typeof type === "string" && typeof message === "string")
					return classifyAnthropicError(type, message);
			}
		}
	} catch {
		// 非 JSON 诊断体：落到通用 HTTP 错误。
	}
	return { kind: "provider", diagnostic: `Anthropic HTTP ${status}` };
}

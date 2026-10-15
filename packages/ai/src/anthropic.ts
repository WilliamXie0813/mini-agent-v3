import { createAssistantMessageEventStream } from "./event-stream.ts";
import { toAnthropicRequest } from "./anthropic-messages.ts";
import { createAnthropicStreamState } from "./anthropic-stream.ts";
import { classifyHttpError } from "./anthropic-error.ts";
import { readSse } from "./sse.ts";
import type { StreamFn } from "./stream-fn.ts";

export interface AnthropicStreamOptions {
	apiKey: string; baseUrl?: string; model?: string; maxTokens?: number;
}

export function createAnthropicStreamFn(options: AnthropicStreamOptions): StreamFn {
	const apiKey = options.apiKey, model = options.model ?? "kimi-for-coding";
	const maxTokens = options.maxTokens ?? 4096;
	if (!apiKey?.trim()) throw new Error("ANTHROPIC_API_KEY (apiKey) is required");
	if (!model.trim()) throw new Error("Anthropic model must not be empty");
	if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
		throw new Error("Anthropic maxTokens must be a positive integer");
	let url: URL;
	try { url = new URL(options.baseUrl ?? "https://api.kimi.com/coding/"); }
	catch { throw new Error("Invalid Anthropic baseUrl"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Anthropic baseUrl must be http(s) without credentials");
	const prefix = url.pathname.replace(/\/+$/, "");
	url.pathname = `${prefix.endsWith("/v1") ? prefix : `${prefix}/v1`}/messages`;
	const diagnostic = (error: unknown) =>
		(error instanceof Error ? error.message : String(error)).split(apiKey).join("[redacted]").slice(0, 1024);
	return (context, signal) => {
		const stream = createAssistantMessageEventStream();
		const state = createAnthropicStreamState(stream, diagnostic);
		queueMicrotask(async () => {
			let body: ReadableStream<Uint8Array> | null = null, reading = false;
			try {
				signal?.throwIfAborted();
				const response = await fetch(url, {
					method: "POST", signal, redirect: "error",
					headers: { "content-type": "application/json",
						"anthropic-version": "2023-06-01", "x-api-key": apiKey },
					body: JSON.stringify(toAnthropicRequest(context, { model, maxTokens })),
				});
				body = response.body;
				if (!response.ok) {
					// 非 2xx：读取有限诊断 body 做结构化分类（超窗 → context_overflow）。
					// text() 已消费流，置空避免 finally 里重复 cancel 产生噪音。
					const classification = classifyHttpError(
						response.status,
						(await response.text()).slice(0, 4096),
					);
					body = null;
					state.fail("error", classification.diagnostic, classification.kind);
					return;
				}
				if (!body) throw new Error("Anthropic response has no body");
				if (response.headers.get("content-type")?.split(";")[0].trim() !== "text/event-stream")
					throw new Error("Anthropic response is not SSE");
				reading = true;
				for await (const frame of readSse(body)) {
					signal?.throwIfAborted();
					state.accept(frame);
					if (state.completed) break;
				}
				if (!state.completed) state.fail("error", "Anthropic stream ended without message_stop");
			} catch (error) {
				if (state.completed) console.error(`Anthropic cleanup: ${diagnostic(error)}`);
				else state.fail(signal?.aborted ? "aborted" : "error",
					signal?.aborted ? "Operation aborted" : diagnostic(error));
			} finally {
				try { if (body && !reading) await body.cancel(); }
				catch (error) { console.error(`Anthropic cleanup: ${diagnostic(error)}`); }
				stream.end();
			}
		});
		return stream;
	};
}

export interface SseFrame { event: string; data: string }

export async function* readSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "", event = "message";
	let data: string[] = [];
	let eof = false;
	let failure: unknown;
	try {
		while (!eof) {
			const chunk = await reader.read();
			eof = chunk.done;
			buffer += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			while (true) {
				const separator = /\r\n|\r|\n/.exec(buffer);
				if (!separator || (!eof && separator[0] === "\r" &&
					separator.index === buffer.length - 1)) break;
				const line = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator[0].length);
				if (line === "") {
					if (data.length) yield { event, data: data.join("\n") };
					event = "message"; data = [];
				} else {
					const colon = line.indexOf(":");
					const field = colon < 0 ? line : line.slice(0, colon);
					const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
					if (field === "event") event = value || "message";
					if (field === "data") data.push(value);
				}
			}
		}
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		try {
			if (!eof) await reader.cancel();
		} catch (cleanup) {
			if (failure instanceof Error) failure.cause = cleanup;
			else throw cleanup;
		} finally {
			reader.releaseLock();
		}
	}
}

import {
	invalid,
	nonEmptyString,
	parseObject,
	success,
} from "./guard-utils.ts";
import type {
	ClientCommand,
	DecodeResult,
} from "./messages.ts";

export function decodeClientCommand(raw: string): DecodeResult<ClientCommand> {
	const parsed = parseObject(raw);
	if (!parsed.ok) return parsed;
	const message = parsed.value;
	const type = message["type"];
	if (typeof type !== "string")
		return invalid("type must be a non-empty string");
	const requestId = nonEmptyString(message, "requestId");
	if (!requestId.ok) return requestId;

	switch (type) {
		case "run.start": {
			const scenarioId = nonEmptyString(message, "scenarioId");
			if (!scenarioId.ok) return scenarioId;
			const prompt = message["prompt"];
			if (typeof prompt !== "string")
				return invalid("prompt must be a string");
			return success({
				type,
				requestId: requestId.value,
				scenarioId: scenarioId.value,
				prompt,
			});
		}
		case "run.abort":
			return success({ type, requestId: requestId.value });
		case "workspace.reset":
			return success({ type, requestId: requestId.value });
		default:
			return invalid(`unknown client command "${type}"`);
	}
}

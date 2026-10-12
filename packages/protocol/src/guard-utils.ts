import type {
	DecodeErrorCode,
	DecodeResult,
} from "./messages.ts";

export type JsonObject = Record<string, unknown>;

export function parseObject(raw: string): DecodeResult<JsonObject> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return failure("INVALID_JSON", "message must be valid JSON");
	}
	return isObject(value)
		? success(value)
		: invalid("message must be a JSON object");
}

export function nonEmptyString(
	value: JsonObject,
	key: string,
): DecodeResult<string> {
	const candidate = value[key];
	return typeof candidate === "string" && candidate.length > 0
		? success(candidate)
		: invalid(`${key} must be a non-empty string`);
}

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function success<T>(value: T): DecodeResult<T> {
	return { ok: true, value };
}

export function invalid<T = never>(message: string): DecodeResult<T> {
	return failure("INVALID_MESSAGE", message);
}

export function failure<T>(
	code: DecodeErrorCode,
	message: string,
): DecodeResult<T> {
	return { ok: false, error: { code, message } };
}

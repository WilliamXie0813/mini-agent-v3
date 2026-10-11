import { describe, expect, it } from "vitest";
import type { JSONSchema } from "@mini-agent/ai";
import { validateJsonSchema } from "../src/json-schema.ts";

describe("validateJsonSchema", () => {
	it("accepts a built-in style object schema", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				path: { type: "string", description: "file path" },
				offset: { type: "number" },
			},
			required: ["path"],
		};

		expect(validateJsonSchema({ path: "a.txt", offset: 2 }, schema))
			.toEqual([]);
	});

	it("reports missing required properties and primitive type errors", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				path: { type: "string" },
				count: { type: "integer" },
			},
			required: ["path", "count"],
		};

		expect(validateJsonSchema({ count: 1.5 }, schema)).toEqual([
			{ path: "arguments.path", message: "is required" },
			{ path: "arguments.count", message: "expected integer, got number" },
		]);
	});

	it("keeps precise nested object and array item paths", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				options: {
					type: "object",
					properties: {
						mode: { type: "string" },
					},
					required: ["mode"],
				},
				tags: {
					type: "array",
					items: { type: "string" },
				},
			},
		};

		expect(validateJsonSchema({
			options: { mode: 3 },
			tags: ["ok", 7],
		}, schema)).toEqual([
			{
				path: "arguments.options.mode",
				message: "expected string, got number",
			},
			{
				path: "arguments.tags[1]",
				message: "expected string, got number",
			},
		]);
	});

	it("validates enum and const with structural JSON equality", () => {
		expect(validateJsonSchema(
			{ b: 2, a: 1 },
			{ enum: [{ a: 1, b: 2 }] },
		)).toEqual([]);
		expect(validateJsonSchema(
			[1, { b: 2, a: 1 }],
			{ const: [1, { a: 1, b: 2 }] },
		)).toEqual([]);
		expect(validateJsonSchema("slow", {
			enum: ["fast", "safe"],
		})).toEqual([{
			path: "arguments",
			message: 'expected one of ["fast","safe"]',
		}]);
	});

	it("rejects additional properties when the schema says false", () => {
		expect(validateJsonSchema(
			{ path: "a.txt", extra: true },
			{
				type: "object",
				properties: { path: { type: "string" } },
				additionalProperties: false,
			},
		)).toEqual([{
			path: "arguments.extra",
			message: "unexpected property",
		}]);
	});

	it("validates string, array, and number boundaries", () => {
		expect(validateJsonSchema("a", {
			type: "string",
			minLength: 2,
			pattern: "^[A-Z]+$",
		})).toEqual([
			{ path: "arguments", message: "must have length >= 2" },
			{ path: "arguments", message: 'must match pattern "^[A-Z]+$"' },
		]);
		expect(validateJsonSchema([1, 2, 3], {
			type: "array",
			maxItems: 2,
		})).toEqual([
			{ path: "arguments", message: "must contain <= 2 items" },
		]);
		expect(validateJsonSchema(11, {
			type: "number",
			minimum: 1,
			maximum: 10,
		})).toEqual([
			{ path: "arguments", message: "must be <= 10" },
		]);
	});

	it("rejects non-finite numbers", () => {
		expect(validateJsonSchema(Number.NaN, { type: "number" })).toEqual([
			{ path: "arguments", message: "expected finite number, got number" },
		]);
		expect(validateJsonSchema(Number.POSITIVE_INFINITY, {
			type: "number",
		})).toEqual([
			{ path: "arguments", message: "expected finite number, got number" },
		]);
	});

	it("reports unsupported validation keywords", () => {
		expect(validateJsonSchema("x", {
			oneOf: [{ type: "string" }],
		})).toEqual([{
			path: "arguments",
			message: 'unsupported schema keyword "oneOf"',
		}]);
		expect(validateJsonSchema({ x: 1 }, {
			type: "object",
			additionalProperties: { type: "number" },
		})).toEqual([{
			path: "arguments",
			message: "schema-valued additionalProperties is not supported",
		}]);
	});

	it("reports an invalid regex as a schema issue instead of throwing", () => {
		expect(validateJsonSchema("x", {
			type: "string",
			pattern: "[",
		})).toEqual([{
			path: "arguments",
			message: 'invalid pattern "["',
		}]);
	});
});

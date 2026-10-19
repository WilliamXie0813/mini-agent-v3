import { describe, expect, test } from "vitest";
import { assertUniqueToolNames } from "../src/tool-names.ts";

describe("assertUniqueToolNames", () => {
	test("accepts distinct names", () => {
		expect(() => assertUniqueToolNames([
			{ name: "read", description: "r", parameters: {}, execute: async () => ({ content: [] }) },
			{ name: "echo", description: "e", parameters: {}, execute: async () => ({ content: [] }) },
		])).not.toThrow();
	});

	test("rejects a duplicate and names the offender", () => {
		expect(() => assertUniqueToolNames([
			{ name: "echo", description: "a", parameters: {}, execute: async () => ({ content: [] }) },
			{ name: "echo", description: "b", parameters: {}, execute: async () => ({ content: [] }) },
		])).toThrowError('duplicate tool name: "echo"');
	});
});

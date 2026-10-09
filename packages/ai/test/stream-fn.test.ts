import { describe, it, expect, beforeEach } from "vitest";
import { setDefaultStreamFn, getDefaultStreamFn } from "../src/stream-fn.ts";
import type { StreamFn } from "../src/stream-fn.ts";

describe("stream-fn slot", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("throws a named error when no implementation is installed", () => {
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});

	it("returns the installed implementation", () => {
		const fn: StreamFn = async function* () {};
		setDefaultStreamFn(fn);
		expect(getDefaultStreamFn()).toBe(fn);
	});

	it("can be cleared back to the uninstalled state", () => {
		setDefaultStreamFn(async function* () {});
		setDefaultStreamFn(undefined);
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});
});

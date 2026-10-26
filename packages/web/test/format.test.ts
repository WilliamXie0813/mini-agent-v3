import { describe, expect, it } from "vitest";

import { formatDuration } from "../src/format.ts";

describe("formatDuration", () => {
	it("rounds milliseconds instead of exposing floating-point noise", () => {
		expect(formatDuration(12.3456789)).toBe("12 ms");
		expect(formatDuration(999.4)).toBe("999 ms");
	});

	it("keeps sub-millisecond values meaningful", () => {
		expect(formatDuration(0)).toBe("0 ms");
		expect(formatDuration(0.42)).toBe("<1 ms");
	});

	it("uses compact units for longer durations", () => {
		expect(formatDuration(1_234.567)).toBe("1.23 s");
		expect(formatDuration(12_345.6)).toBe("12.3 s");
		expect(formatDuration(61_000)).toBe("1m 1s");
		expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
	});

	it("does not render invalid durations as numbers", () => {
		expect(formatDuration(Number.NaN)).toBe("—");
		expect(formatDuration(-1)).toBe("—");
	});
});

import type { SessionEntry } from "@mini-agent/core";
import { describe, expect, it } from "vitest";
import { activeSessionPath } from "../src/session-path.ts";

let created = 0;
function entry(id: string, parentId: string | null): SessionEntry {
	created += 1;
	return {
		type: "submission",
		id,
		parentId,
		createdAt: new Date(1700000000000 + created).toISOString(),
		requestId: `request-${id}`,
		prompt: `prompt ${id}`,
	};
}

// 物理顺序 A,B,C,D,E；parent tree：A→B→C 与 A→D→E（B/C 属于被 branch 丢下的旧分支）。
function branchedEntries(): SessionEntry[] {
	return [
		entry("A", null),
		entry("B", "A"),
		entry("C", "B"),
		entry("D", "A"),
		entry("E", "D"),
	];
}

describe("activeSessionPath", () => {
	it("walks the parent chain from the leaf instead of physical order", () => {
		const entries = branchedEntries();
		expect(activeSessionPath(entries, "E").map((item) => item.id))
			.toEqual(["A", "D", "E"]);
		expect(activeSessionPath(entries, "C").map((item) => item.id))
			.toEqual(["A", "B", "C"]);
	});

	it("returns an empty path when the leaf is null", () => {
		expect(activeSessionPath([], null)).toEqual([]);
		expect(activeSessionPath(branchedEntries(), null)).toEqual([]);
	});

	it("rejects an unknown leaf", () => {
		expect(() => activeSessionPath(branchedEntries(), "missing"))
			.toThrowError("Unknown session entry: missing");
	});

	it("rejects an unknown parent instead of silently truncating", () => {
		const entries = [entry("X", "ghost")];
		expect(() => activeSessionPath(entries, "X"))
			.toThrowError("Unknown session entry: ghost");
	});

	it("rejects a parent cycle instead of looping forever", () => {
		const entries = [entry("X", "Y"), entry("Y", "X")];
		expect(() => activeSessionPath(entries, "X")).toThrowError(/cycle/);
		const selfCycle = [entry("Z", "Z")];
		expect(() => activeSessionPath(selfCycle, "Z")).toThrowError(/cycle/);
	});

	it("returns clones so transport callers cannot mutate session memory", () => {
		const entries = branchedEntries();
		const path = activeSessionPath(entries, "E");
		expect(path).toHaveLength(3);
		expect(path[0]).toEqual(entries[0]);
		expect(path[0]).not.toBe(entries[0]);
	});
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../src", import.meta.url).pathname;

function listSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			files.push(...listSourceFiles(path));
		} else if (name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("protocol import boundary", () => {
	it("imports @mini-agent/core only as types", () => {
		const sources = listSourceFiles(SRC_DIR);
		expect(sources.length).toBeGreaterThan(0);
		for (const path of sources) {
			const source = readFileSync(path, "utf8");
			for (const line of source.split("\n")) {
				if (!line.includes('"@mini-agent/core"')) continue;
				expect(line).toMatch(/^\s*import type\b/);
			}
			expect(source).not.toContain("@mini-agent/core/");
		}
	});
});

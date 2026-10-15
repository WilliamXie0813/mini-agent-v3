import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("extensions source boundary", () => {
	const files = sourceFiles(join(import.meta.dirname, "..", "src"));

	test("every @mini-agent/core import is type-only", () => {
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.includes('"@mini-agent/core"')) continue;
				expect(line, `${file}: ${line}`).toMatch(/^\s*import type\b/);
			}
		}
	});

	test("no deep imports and no third-party runtime deps", () => {
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text, file).not.toContain("@mini-agent/core/");
			expect(text, file).not.toMatch(/from\s+"@ai-sdk\//);
			expect(text, file).not.toMatch(/from\s+"jiti"/);
		}
	});
});

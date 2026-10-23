import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// 不用 new URL(...).pathname：jsdom 环境会用页面 base URL 重写全局 URL。
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			files.push(...listSourceFiles(path));
		} else if (/\.tsx?$/.test(name)) {
			files.push(path);
		}
	}
	return files;
}

const FORBIDDEN = [
	/@mini-agent\/core/,
	/@mini-agent\/ai\b/,
	/@mini-agent\/server/,
	/@mini-agent\/[a-z-]+\/src\//,
];

describe("web import boundary", () => {
	it("never imports core, ai, server, or deep workspace paths", () => {
		const sources = listSourceFiles(SRC_DIR);
		expect(sources.length).toBeGreaterThan(0);
		for (const path of sources) {
			const source = readFileSync(path, "utf8");
			for (const pattern of FORBIDDEN) {
				expect(source, `${path} must not match ${pattern}`).not.toMatch(
					pattern,
				);
			}
		}
	});
});

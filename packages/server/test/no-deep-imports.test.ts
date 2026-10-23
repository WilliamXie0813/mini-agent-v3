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

describe("server import boundary", () => {
	it("uses workspace package roots only, never deep or cross-package relative imports", () => {
		const sources = listSourceFiles(SRC_DIR);
		expect(sources.length).toBeGreaterThan(0);
		for (const path of sources) {
			const source = readFileSync(path, "utf8");
			// 包根 import（"@mini-agent/core"）允许；带路径后缀的 deep import 禁止。
			expect(source).not.toMatch(/@mini-agent\/(core|ai|extensions)\//);
			// 相对路径不得跨出本包进入其他 workspace 包。
			expect(source).not.toMatch(/"\.\.\/(core|ai|extensions|protocol)/);
		}
	});
});

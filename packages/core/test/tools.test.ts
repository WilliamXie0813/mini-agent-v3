import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, createEditTool, createBashTool } from "../src/tools.ts";
import type { ToolResult } from "../src/tool.ts";
import type { ContentBlock } from "@mini-agent/ai";

let dir: string;
let prevCwd: string;

// 工具按 process.cwd() 解析参数，测试必须控制 cwd 才能断言相对路径行为。
beforeEach(async () => {
	prevCwd = process.cwd();
	dir = await mkdtemp(join(tmpdir(), "mini-agent-tools-"));
	process.chdir(dir);
});

afterEach(async () => {
	process.chdir(prevCwd);
	// 超时/中止用例的孙进程（cmd.exe 被杀后孤儿化的 node）仍把 dir 当 cwd 握着，
	// Windows 上目录删除会 EBUSY 到它自然退出（约 60s）；重试后仍失败就放弃清理，不阻塞测试。
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 9) return;
			await new Promise((r) => setTimeout(r, 200));
		}
	}
});

function text(result: ToolResult): string {
	return result.content.filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text").map((c) => c.text).join("");
}

describe("read tool", () => {
	it("returns the file with 1-based line numbers", async () => {
		await writeFile("a.txt", "one\ntwo\n");
		const r = await createReadTool().execute({ path: "a.txt" });
		expect(r.isError).toBeFalsy();
		expect(text(r)).toBe("     1\tone\n     2\ttwo");
	});

	it("honors offset and limit", async () => {
		await writeFile("a.txt", "1\n2\n3\n4\n5\n");
		const r = await createReadTool().execute({ path: "a.txt", offset: 2, limit: 2 });
		expect(text(r)).toBe("     2\t2\n     3\t3");
	});

	it("returns an error result, not a throw, for a missing file", async () => {
		const r = await createReadTool().execute({ path: "nope.txt" });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/nope\.txt/);
	});
});

describe("edit tool", () => {
	it("replaces a unique occurrence", async () => {
		await writeFile("a.txt", "hello world\n");
		const r = await createEditTool().execute({ path: "a.txt", oldText: "world", newText: "there" });
		expect(r.isError).toBeFalsy();
		expect(await readFile("a.txt", "utf8")).toBe("hello there\n");
	});

	it("errors and leaves the file untouched when oldText appears zero times", async () => {
		await writeFile("a.txt", "hello\n");
		const r = await createEditTool().execute({ path: "a.txt", oldText: "absent", newText: "x" });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/0 times|not found/i);
		expect(await readFile("a.txt", "utf8")).toBe("hello\n");
	});

	it("errors and leaves the file untouched when oldText appears more than once", async () => {
		await writeFile("a.txt", "x\nx\n");
		const r = await createEditTool().execute({ path: "a.txt", oldText: "x", newText: "y" });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/2 times|multiple/i);
		expect(await readFile("a.txt", "utf8")).toBe("x\nx\n");
	});

	it("writes newText literally, without interpreting $& or other replacement patterns", async () => {
		await writeFile("a.txt", "value\n");
		const r = await createEditTool().execute({ path: "a.txt", oldText: "value", newText: "$& and $' literal" });
		expect(r.isError).toBeFalsy();
		expect(await readFile("a.txt", "utf8")).toBe("$& and $' literal\n");
	});

	it("preserves both updates when two edits target the same file concurrently", async () => {
		await writeFile("a.txt", "alpha beta\n");
		const tool = createEditTool();

		await Promise.all([
			tool.execute({
				path: "a.txt",
				oldText: "alpha",
				newText: "ALPHA",
			}),
			tool.execute({
				path: "a.txt",
				oldText: "beta",
				newText: "BETA",
			}),
		]);

		expect(await readFile("a.txt", "utf8")).toBe("ALPHA BETA\n");
	});

	it("serializes edits through a symlink alias", async () => {
		await writeFile("a.txt", "alpha beta\n");
		await symlink(join(dir, "a.txt"), "alias.txt");
		const tool = createEditTool();

		await Promise.all([
			tool.execute({
				path: "a.txt",
				oldText: "alpha",
				newText: "ALPHA",
			}),
			tool.execute({
				path: "alias.txt",
				oldText: "beta",
				newText: "BETA",
			}),
		]);

		expect(await readFile("a.txt", "utf8")).toBe("ALPHA BETA\n");
	});
});

describe("bash tool", () => {
	it("returns stdout for a successful command", async () => {
		const r = await createBashTool().execute({ command: "echo hi" });
		expect(r.isError).toBeFalsy();
		expect(text(r)).toContain("hi");
	});

	it("marks a non-zero exit code as an error result, including stderr", async () => {
		const r = await createBashTool().execute({ command: "node -e \"console.error('bad'); process.exit(3)\"" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("bad");
		expect(text(r)).toContain("3");
	});

	it("kills a command that outlives the timeout instead of hanging", async () => {
		const r = await createBashTool({ timeoutMs: 300 }).execute({ command: "node -e \"setTimeout(()=>{}, 60000)\"" });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/timed out|timeout/i);
	}, 5000);

	it("is aborted by the signal", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const r = await createBashTool().execute({ command: "node -e \"setTimeout(()=>{}, 60000)\"" }, controller.signal);
		expect(r.isError).toBe(true);
	}, 5000);
});

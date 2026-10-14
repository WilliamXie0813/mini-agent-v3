import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
const fixture = (name: string) => readFile(new URL(`../fixtures/${name}.sse`, import.meta.url), "utf8");

async function runCli(input: string, replies: { status?: number; body: string }[], authenticated = true) {
	const cwd = await mkdtemp(join(tmpdir(), "mini-stage7-cli-"));
	const requests: unknown[] = [];
	let activeChild: ReturnType<typeof spawn> | undefined;
	const server = createServer((req, res) => {
		let source = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => { source += chunk; });
		req.on("end", () => {
			requests.push(JSON.parse(source));
			const reply = replies[requests.length - 1];
			if (!reply) { res.writeHead(500); res.end("unexpected request"); return; }
			res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream" });
			// Separate writes let the subprocess prove visible progress before completion.
			const cut = reply.body.indexOf("event: content_block_stop");
			if (cut > 0) {
				res.write(reply.body.slice(0, cut));
				setTimeout(() => res.end(reply.body.slice(cut)), 30);
			} else res.end(reply.body);
		});
	});
	try {
		await writeFile(join(cwd, "package.json"), '{"name":"non-sensitive-teaching-fixture"}\n');
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("server missing port");
		const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: "local-test-key",
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/coding/`, ANTHROPIC_MODEL: "local-test" };
		if (!authenticated) delete env.ANTHROPIC_API_KEY;
		const child = activeChild = spawn(process.execPath, ["--experimental-strip-types", cli], { cwd, env });
		let stdout = "", stderr = "";
		const chunks: string[] = [];
		child.stdout.on("data", (data: Buffer) => { const value = String(data); stdout += value; chunks.push(value); });
		child.stderr.on("data", (data: Buffer) => { stderr += data; });
		const exit = new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		child.stdin.end(input);
		const code = await exit;
		return { code, stdout, stderr, requests, chunks };
	} finally {
		if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(join(cwd, "package.json"), { force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}

describe("CLI composition root", () => {
	it("uses the real provider for text, read and the follow-up response", async () => {
		const result = await runCli("读一下 package.json 然后总结\n/exit\n", [
			{ body: await fixture("toolcall") }, { body: await fixture("text") },
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("mini-agent (stage 8)");
		expect(result.stdout).toContain('→ read {"path":"package.json"}');
		expect(result.stdout).toContain("你好，文件已读。");
		expect(result.stdout).not.toContain("deterministic fake");
		expect(result.requests).toHaveLength(2);
		// 阶段 8：leading system text 与 stage 7 完全一致，但来源是 transcript 重放。
		expect(result.requests[0]).toMatchObject({
			system: "You are a minimal teaching agent.",
		});
		const wire = result.requests[0] as {
			messages: { role: string }[];
			tools: Record<string, unknown>[];
		};
		// wire messages 第一条是 user；system entries 不进入 wire messages。
		expect(wire.messages[0]!.role).toBe("user");
		expect(wire.messages.every((message) => message.role !== "system")).toBe(true);
		// 内部 IR 字段不出站；tools 只有 model-visible declaration（无 execute 等运行时键）。
		expect(JSON.stringify(result.requests[0])).not.toMatch(/sections|toolsAdded|toolsRemoved/);
		for (const tool of wire.tools) {
			expect(Object.keys(tool).sort()).toEqual(["description", "input_schema", "name"]);
		}
		expect(result.requests[1]).toMatchObject({
			messages: [{ role: "user" }, { role: "assistant" }, {
				role: "user", content: [{ type: "tool_result", tool_use_id: "c1",
					content: [{ type: "text", text: expect.stringContaining("non-sensitive-teaching-fixture") }] }],
			}],
		});
		expect(result.chunks.some((chunk) => chunk.includes("你好，"))).toBe(true);
	});

	it("fails clearly when the API key is missing rather than falling back to fake", async () => {
		const result = await runCli("/exit\n", [], false);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("ANTHROPIC_API_KEY");
		expect(result.stdout).not.toContain("deterministic fake");
		expect(result.requests).toEqual([]);
	});

	it("shows an HTTP diagnostic and accepts a subsequent successful prompt", async () => {
		const result = await runCli("one\ntwo\n/exit\n", [
			{ status: 500, body: "not a successful reply" }, { body: await fixture("text") },
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("✗ Anthropic HTTP 500");
		expect(result.stdout).toContain("你好，文件已读。");
		expect(result.requests[1]).toMatchObject({ messages: [{ role: "user", content: [
			{ type: "text", text: "one" }, { type: "text", text: "two" },
		] }] });
	});
});

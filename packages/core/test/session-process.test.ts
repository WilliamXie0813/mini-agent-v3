import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(
	new URL("./fixtures/session-process.ts", import.meta.url),
);
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-process-"));
	directories.push(directory);
	return directory;
}

type Child = ReturnType<typeof spawn>;

function start(mode: string, directory: string, ...args: string[]): Child {
	return spawn(
		process.execPath,
		["--experimental-strip-types", fixture, mode, directory, ...args],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
}

async function waitForJson(child: Child): Promise<Record<string, unknown>> {
	let buffer = "";
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += String(chunk);
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`child output timed out: ${stderr}`));
		}, 5_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdout!.on("data", (chunk: Buffer) => {
			buffer += String(chunk);
			const lineEnd = buffer.indexOf("\n");
			if (lineEnd < 0) return;
			clearTimeout(timer);
			try {
				resolve(JSON.parse(buffer.slice(0, lineEnd)));
			} catch (error) {
				reject(error);
			}
		});
		child.once("close", (code, signal) => {
			if (buffer.includes("\n")) return;
			clearTimeout(timer);
			reject(new Error(
				`child exited before JSON: code=${code} signal=${signal} ${stderr}`,
			));
		});
	});
}

async function run(
	mode: string,
	directory: string,
	...args: string[]
): Promise<Record<string, unknown>> {
	const child = start(mode, directory, ...args);
	const result = await waitForJson(child);
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	expect(code).toBe(0);
	return result;
}

async function killAfterReady(
	mode: string,
	directory: string,
	...args: string[]
): Promise<Record<string, unknown>> {
	const child = start(mode, directory, ...args);
	const ready = await waitForJson(child);
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});
	return ready;
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("session process recovery", () => {
	it("continues two completed rounds after the process is killed", async () => {
		const directory = await temporaryDirectory();
		const ready = await killAfterReady("completed-runs", directory);
		const path = String(ready.path);

		const resumed = await run("resume", directory, path);

		expect(resumed.before).toEqual([
			"first prompt",
			"first answer",
			"second prompt",
			"second answer",
		]);
		expect(resumed.after).toEqual([
			...resumed.before as string[],
			"third prompt",
			"third answer",
		]);
	});

	it.each([
		["safe", 2, false],
		["unsafe", 1, true],
	] as const)("recovers a %s tool after SIGKILL", async (
		replay,
		expectedCount,
		isError,
	) => {
		const directory = await temporaryDirectory();
		const countPath = join(directory, "count.txt");
		const ready = await killAfterReady(
			`tool-crash-${replay}`,
			directory,
			"",
			countPath,
		);
		const path = String(ready.path);

		const recovered = await run(
			`recover-${replay}`,
			directory,
			path,
			countPath,
		);

		expect(recovered.count).toBe(expectedCount);
		const results = recovered.results as Array<{
			isError: boolean;
			content: Array<{ type: string; text: string }>;
		}>;
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(isError);
		const content = results[0]!.content.map(({ text }) => text).join("\n");
		if (replay === "safe") expect(content).toContain("replayed result");
		else {
			expect(content).toContain("committed partial");
			expect(content).toMatch(/interrupted.*unsafe/i);
		}
		expect(Number(await readFile(countPath, "utf8"))).toBe(expectedCount);
	});
});

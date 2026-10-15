import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createFakeStreamFn } from "@mini-agent/ai";
import { AgentSession } from "../../src/agent-session.ts";
import type { ToolDef } from "../../src/tool.ts";

const [mode, directory, sessionPath, countPath] = process.argv.slice(2);
if (!mode || !directory) throw new Error("mode and directory are required");

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function textMessages(session: AgentSession): string[] {
	return session.state.messages.flatMap((message) => {
		if (!("content" in message)) return [];
		return message.content.flatMap((block) =>
			block.type === "text" ? [block.text] : []
		);
	});
}

async function readCount(path: string): Promise<number> {
	try {
		return Number(await readFile(path, "utf8"));
	} catch {
		return 0;
	}
}

async function increment(path: string): Promise<number> {
	const value = await readCount(path) + 1;
	await writeFile(path, String(value));
	return value;
}

async function waitForever(): Promise<never> {
	setInterval(() => {}, 1_000);
	return new Promise(() => {});
}

if (mode === "completed-runs") {
	const session = await AgentSession.create({
		directory,
		system: "test",
		streamFn: createFakeStreamFn(["first answer", "second answer"]),
	});
	await session.submit({ requestId: "one", prompt: "first prompt" });
	await session.submit({ requestId: "two", prompt: "second prompt" });
	output({ ready: true, path: session.filePath });
	await waitForever();
}

if (mode === "resume") {
	if (!sessionPath) throw new Error("session path is required");
	const session = await AgentSession.open({
		path: sessionPath,
		directory,
		system: "ignored",
		streamFn: createFakeStreamFn(["third answer"]),
	});
	const before = textMessages(session);
	await session.submit({ requestId: "three", prompt: "third prompt" });
	output({ before, after: textMessages(session) });
}

if (mode === "tool-crash-safe" || mode === "tool-crash-unsafe") {
	if (!countPath) throw new Error("count path is required");
	const replay = mode === "tool-crash-safe" ? "safe" : "unsafe";
	let session!: AgentSession;
	const crashTool: ToolDef = {
		name: "crash",
		description: "crash tool",
		replay,
		parameters: { type: "object" },
		execute: async (_args, _signal, onUpdate) => {
			const count = await increment(countPath);
			onUpdate?.({ content: [{ type: "text", text: "committed partial" }] });
			while (!session.entries.some((entry) => entry.type === "tool_update"))
				await sleep(5);
			output({ ready: true, path: session.filePath, count });
			return waitForever();
		},
	};
	session = await AgentSession.create({
		directory,
		system: "test",
		tools: [crashTool],
		streamFn: createFakeStreamFn([[
			{ type: "toolCall", id: "c1", name: "crash", arguments: {} },
		]]),
	});
	await session.submit({ requestId: "crash", prompt: "go" });
}

if (mode === "recover-safe" || mode === "recover-unsafe") {
	if (!sessionPath || !countPath)
		throw new Error("session path and count path are required");
	const replay = mode === "recover-safe" ? "safe" : "unsafe";
	const crashTool: ToolDef = {
		name: "crash",
		description: "crash tool",
		replay,
		parameters: { type: "object" },
		execute: async () => {
			await increment(countPath);
			return { content: [{ type: "text", text: "replayed result" }] };
		},
	};
	const session = await AgentSession.open({
		path: sessionPath,
		directory,
		system: "ignored",
		tools: [crashTool],
		streamFn: createFakeStreamFn(["unused"]),
	});
	const results = session.state.messages.filter(
		(message) => message.role === "toolResult",
	);
	output({
		count: await readCount(countPath),
		results,
	});
}

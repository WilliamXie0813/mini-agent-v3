import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent-session.ts";
import type { ToolDef } from "../src/tool.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-session-queued-"));
	directories.push(directory);
	return directory;
}

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	execute: async ({ text }) => ({
		content: [{ type: "text", text }],
	}),
};

function toolCall(id: string) {
	return [{
		type: "toolCall" as const,
		id,
		name: "echo",
		arguments: { text: id },
	}];
}

function textOf(message: Message): string {
	if (message.role === "system") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function userTexts(messages: readonly Message[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => textOf(message));
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("AgentSession queued user messages", () => {
	it("persists steering and follow-up users for exact reopen replay", async () => {
		const directory = await temporaryDirectory();
		const tools = [echoTool];
		const streamFn = createFakeStreamFn([
			toolCall("c1"),
			"middle",
			"final",
		]);
		const session = await AgentSession.create({
			directory,
			system: "test",
			tools,
			streamFn,
		});
		let turn = 0;
		session.subscribe((event) => {
			if (event.type === "tool_execution_end") session.steer("change");
			if (event.type === "turn_end") {
				turn++;
				if (turn === 2) session.followUp("again");
			}
		});

		await session.submit({ requestId: "r1", prompt: "go" });

		const journalBeforeReopen = await readFile(session.filePath, "utf8");
		const diskEntries = journalBeforeReopen
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line) as {
				type: string;
				message?: Message;
			});
		const persistedUsers = diskEntries.flatMap((entry) =>
			entry.type === "message" && entry.message?.role === "user"
				? [textOf(entry.message)]
				: []
		);
		expect(persistedUsers).toEqual(["change", "again"]);

		const reopened = await AgentSession.open({
			path: session.filePath,
			system: "ignored",
			tools,
			streamFn,
		});

		expect(reopened.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "toolResult", "user", "assistant",
			"user", "assistant",
		]);
		expect(userTexts(reopened.state.messages)).toEqual(["go", "change", "again"]);
		expect(reopened.state.messages).toEqual(session.state.messages);
		expect(reopened.entries.filter((entry) => entry.type === "submission"))
			.toHaveLength(1);
		expect(reopened.entries.filter((entry) => entry.type === "run_end"))
			.toHaveLength(1);
		expect(await readFile(reopened.filePath, "utf8")).toBe(journalBeforeReopen);
	});

	it("rejects steering and follow-up calls while idle", async () => {
		const session = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "test",
			streamFn: createFakeStreamFn(["unused"]),
		});

		expect(() => session.steer("change")).toThrow(/Cannot steer.*active run/);
		expect(() => session.followUp("again")).toThrow(/Cannot followUp.*active run/);
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeStreamFn } from "@mini-agent/ai";
import { AgentSession } from "@mini-agent/core";
import type {
	AgentEventEnvelope,
	ServerMessage,
	SessionSnapshot,
} from "@mini-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../src/session-host.ts";
import type {
	ServerMessageSink,
	SessionHostOptions,
} from "../src/session-host.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-session-host-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

function collector(): { messages: ServerMessage[]; sink: ServerMessageSink } {
	const messages: ServerMessage[] = [];
	return { messages, sink: (message) => messages.push(message) };
}

function agentEvents(messages: ServerMessage[]): AgentEventEnvelope[] {
	return messages.flatMap((message) =>
		message.type === "agent.event" ? [message.envelope] : []
	);
}

function completionOf(
	messages: ServerMessage[],
	requestId: string,
): Extract<ServerMessage, { type: "command.completed" }> | undefined {
	return messages.find(
		(message): message is Extract<ServerMessage, { type: "command.completed" }> =>
			message.type === "command.completed" && message.requestId === requestId,
	);
}

async function createHost(
	script: string[],
	options: {
		delayMs?: number;
		keepRecentTurns?: number;
		host?: SessionHostOptions;
	} = {},
): Promise<{ session: AgentSession; host: SessionHost }> {
	const session = await AgentSession.create({
		directory: await temporaryDirectory(),
		system: "test system",
		streamFn: createFakeStreamFn(script, { delayMs: options.delayMs }),
		...(options.keepRecentTurns !== undefined
			? { compaction: { keepRecentTurns: options.keepRecentTurns } }
			: {}),
	});
	return { session, host: new SessionHost(session, options.host) };
}

async function settled(
	messages: ServerMessage[],
	requestId: string,
): Promise<void> {
	await vi.waitFor(() => {
		expect(completionOf(messages, requestId)).toBeDefined();
	});
}

describe("SessionHost snapshots and attach", () => {
	it("reports the active branch path without old-branch descendants", async () => {
		const { session, host } = await createHost(["first answer", "second answer"]);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "first" },
			replies.sink,
		);
		await settled(replies.messages, "r1");
		// branch 回 run 1 的 submission，run 1 的 assistant/run_end 成为旧分支。
		const firstSubmission = session.entries.find(
			(entry) => entry.type === "submission",
		);
		const keptIds = new Set(session.entries
			.filter((entry) =>
				entry.type === "message" || entry.id === firstSubmission?.id
			)
			.map((entry) => entry.id));
		const oldBranchIds = session.entries
			.map((entry) => entry.id)
			.filter((id) => !keptIds.has(id));
		expect(oldBranchIds.length).toBeGreaterThan(0);
		session.branch(firstSubmission!.id);
		host.handle(
			{ type: "prompt.submit", requestId: "r2", prompt: "second" },
			replies.sink,
		);
		await settled(replies.messages, "r2");

		const snapshot = host.snapshot();
		expect(snapshot.status).toBe("idle");
		expect(snapshot.leafId).toBe(session.leafId);
		expect(snapshot.transientEvents).toEqual([]);
		const ids = snapshot.entries.map((entry) => entry.id);
		for (const id of oldBranchIds) expect(ids).not.toContain(id);
		expect(ids.at(-1)).toBe(session.leafId);
		expect(snapshot.entries[0]!.parentId).toBeNull();
		for (let index = 1; index < snapshot.entries.length; index++) {
			expect(snapshot.entries[index]!.parentId)
				.toBe(snapshot.entries[index - 1]!.id);
		}
	});

	it("sends a session.snapshot as the first message on attach", async () => {
		const { session, host } = await createHost(["unused"]);
		const client = collector();
		host.attach(client.sink);
		expect(client.messages[0]?.type).toBe("session.snapshot");
		const first = client.messages[0];
		if (first?.type !== "session.snapshot")
			throw new Error("expected a session.snapshot message");
		expect(first.snapshot.sessionId).toBe(session.sessionId);
		expect(first.snapshot.status).toBe("idle");
	});

	it("delivers a live event triggered inside the snapshot send after the snapshot", async () => {
		const { session, host } = await createHost(["hello there"]);
		const messages: ServerMessage[] = [];
		let submission: Promise<unknown> | undefined;
		host.attach((message) => {
			messages.push(message);
			if (message.type === "session.snapshot" && submission === undefined) {
				// 在 snapshot send 回调里直接触发 run：事件绝不能跑到 snapshot 前面，也不能丢。
				submission = session.submit({ requestId: "direct", prompt: "hello" });
				submission.catch(() => {});
			}
		});
		expect(messages[0]?.type).toBe("session.snapshot");
		await submission;
		const envelopes = agentEvents(messages);
		expect(envelopes.length).toBeGreaterThan(0);
		expect(envelopes.some((envelope) => envelope.event.type === "agent_end"))
			.toBe(true);
		expect(envelopes.map((envelope) => envelope.sequence))
			.toEqual(envelopes.map((_, index) => index));
		const firstEventIndex = messages.findIndex(
			(message) => message.type === "agent.event",
		);
		expect(firstEventIndex).toBeGreaterThan(0);
	});

	it("stops delivering after detach while the session stays submittable", async () => {
		const { host } = await createHost(["answer"]);
		const client = collector();
		const detach = host.attach(client.sink);
		detach();
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "hello" },
			replies.sink,
		);
		await settled(replies.messages, "r1");
		expect(client.messages).toHaveLength(1);
		expect(agentEvents(client.messages)).toHaveLength(0);
	});
});

describe("SessionHost prompt commands", () => {
	it("accepts a prompt before the first agent event and completes with the durable submission id", async () => {
		const { session, host } = await createHost(["hello world"]);
		const client = collector();
		host.attach(client.sink);
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "say hi" },
			client.sink,
		);
		await settled(client.messages, "r1");

		const acceptedIndex = client.messages.findIndex(
			(message) => message.type === "command.accepted",
		);
		const firstEventIndex = client.messages.findIndex(
			(message) => message.type === "agent.event",
		);
		expect(acceptedIndex).toBeGreaterThanOrEqual(0);
		expect(firstEventIndex).toBeGreaterThan(acceptedIndex);
		expect(client.messages.at(-1)?.type).toBe("command.completed");

		const envelopes = agentEvents(client.messages);
		expect(envelopes.length).toBeGreaterThan(0);
		expect(envelopes.map((envelope) => envelope.sequence))
			.toEqual(envelopes.map((_, index) => index));
		for (const envelope of envelopes) {
			expect(envelope.sessionId).toBe(session.sessionId);
		}

		const submission = session.entries.find(
			(entry) => entry.type === "submission",
		);
		expect(completionOf(client.messages, "r1")).toMatchObject({
			command: "prompt.submit",
			result: { submissionId: submission!.id },
		});
	});

	it("stamps non-negative, monotonic elapsedMs from the injected clock", async () => {
		let tick = 100;
		const { host } = await createHost(["timed answer"], {
			host: { now: () => (tick += 25) },
		});
		const client = collector();
		host.attach(client.sink);
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "time me" },
			client.sink,
		);
		await settled(client.messages, "r1");
		const envelopes = agentEvents(client.messages);
		expect(envelopes.length).toBeGreaterThan(1);
		for (const envelope of envelopes) {
			expect(envelope.elapsedMs).toBeGreaterThanOrEqual(0);
		}
		for (let index = 1; index < envelopes.length; index++) {
			expect(envelopes[index]!.elapsedMs)
				.toBeGreaterThanOrEqual(envelopes[index - 1]!.elapsedMs);
		}
	});

	it("rejects a prompt with a different requestId while a run is active", async () => {
		const { host } = await createHost(
			["a somewhat longer answer that stays in flight for a while"],
			{ delayMs: 10 },
		);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "first" },
			replies.sink,
		);
		host.handle(
			{ type: "prompt.submit", requestId: "r2", prompt: "second" },
			replies.sink,
		);
		expect(replies.messages).toContainEqual({
			type: "protocol.error",
			requestId: "r2",
			code: "RUN_ACTIVE",
			message: expect.any(String),
		});
		await settled(replies.messages, "r1");
		expect(completionOf(replies.messages, "r2")).toBeUndefined();
	});

	it("reuses the in-flight submission for a repeated requestId", async () => {
		let providerCalls = 0;
		const session = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "test system",
			streamFn: (context, signal) => {
				providerCalls += 1;
				return createFakeStreamFn(
					["a somewhat longer streaming answer that stays in flight"],
					{ delayMs: 10 },
				)(context, signal);
			},
		});
		const host = new SessionHost(session);
		const first = collector();
		const second = collector();
		const command = {
			type: "prompt.submit",
			requestId: "r1",
			prompt: "hello",
		} as const;
		host.handle(command, first.sink);
		host.handle(command, second.sink);
		await settled(first.messages, "r1");
		await settled(second.messages, "r1");
		expect(providerCalls).toBe(1);
		expect(second.messages.some((message) => message.type === "command.accepted"))
			.toBe(true);
		const firstCompleted = completionOf(first.messages, "r1");
		const secondCompleted = completionOf(second.messages, "r1");
		if (
			firstCompleted?.command !== "prompt.submit" ||
			secondCompleted?.command !== "prompt.submit"
		)
			throw new Error("expected prompt.submit completions");
		const submission = session.entries.find(
			(entry) => entry.type === "submission",
		);
		expect(firstCompleted.result.submissionId).toBe(submission!.id);
		expect(secondCompleted.result.submissionId).toBe(submission!.id);
	});
});

describe("SessionHost active snapshot seam", () => {
	it("keeps the snapshot on the pre-run leaf with transient events while running", async () => {
		const session = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "test system",
			streamFn: createFakeStreamFn(
				["a longer answer that keeps streaming for a while"],
				{ delayMs: 10 },
			),
		});
		let midRun: SessionSnapshot | undefined;
		const host = new SessionHost(session, {
			onEvent: (event) => {
				if (event.type === "message_update" && midRun === undefined)
					midRun = host.snapshot();
			},
		});
		const baseLeaf = session.leafId;
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "stream please" },
			replies.sink,
		);
		await vi.waitFor(() => expect(midRun).toBeDefined());
		expect(midRun!.status).toBe("running");
		expect(midRun!.leafId).toBe(baseLeaf);
		expect(midRun!.entries.map((entry) => entry.type))
			.not.toContain("submission");
		expect(midRun!.transientEvents.map((item) => item.event.type))
			.toEqual(expect.arrayContaining([
				"agent_start",
				"turn_start",
				"message_start",
				"message_update",
			]));

		await settled(replies.messages, "r1");
		const settledSnapshot = host.snapshot();
		expect(settledSnapshot.status).toBe("idle");
		expect(settledSnapshot.transientEvents).toEqual([]);
		expect(settledSnapshot.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
	});
});

describe("SessionHost abort, compact, and close", () => {
	it("rejects run.abort with NO_ACTIVE_RUN when idle", async () => {
		const { host } = await createHost(["unused"]);
		const replies = collector();
		host.handle({ type: "run.abort", requestId: "a1" }, replies.sink);
		expect(replies.messages).toEqual([{
			type: "protocol.error",
			requestId: "a1",
			code: "NO_ACTIVE_RUN",
			message: expect.any(String),
		}]);
	});

	it("abort only signals the run; the terminal state arrives via agent events", async () => {
		const { session, host } = await createHost(
			["a very long answer that keeps streaming so the abort lands mid-run"],
			{ delayMs: 10 },
		);
		const client = collector();
		host.attach(client.sink);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "go" },
			replies.sink,
		);
		// core 的 abort 只作用于已开始的 run；等 streaming 起步再发信号。
		await vi.waitFor(() => {
			expect(
				agentEvents(client.messages).some(
					(envelope) => envelope.event.type === "message_update",
				),
			).toBe(true);
		});
		host.handle({ type: "run.abort", requestId: "a1" }, replies.sink);
		expect(replies.messages).toContainEqual({
			type: "command.accepted",
			requestId: "a1",
			command: "run.abort",
		});
		expect(completionOf(replies.messages, "a1")).toEqual({
			type: "command.completed",
			requestId: "a1",
			command: "run.abort",
			result: {},
		});
		await settled(replies.messages, "r1");
		expect(session.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "aborted" });
		expect(
			agentEvents(client.messages).some(
				(envelope) => envelope.event.type === "agent_end",
			),
		).toBe(true);
	});

	it("reports compacting status with pre-operation entries and compaction events", async () => {
		const session = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "test system",
			compaction: { keepRecentTurns: 1 },
			streamFn: createFakeStreamFn(
				["run one answer", "compact summary of the earlier run"],
				{ delayMs: 10 },
			),
		});
		let compacting: SessionSnapshot | undefined;
		const host = new SessionHost(session, {
			onEvent: (event) => {
				if (event.type === "compaction_start" && compacting === undefined)
					compacting = host.snapshot();
			},
		});
		const client = collector();
		host.attach(client.sink);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "first" },
			replies.sink,
		);
		await settled(replies.messages, "r1");
		const baseLeaf = session.leafId;

		host.handle({ type: "session.compact", requestId: "c1" }, replies.sink);
		await vi.waitFor(() => expect(compacting).toBeDefined());
		expect(compacting!.status).toBe("compacting");
		expect(compacting!.leafId).toBe(baseLeaf);
		expect(compacting!.entries.at(-1)).toMatchObject({ type: "run_end" });
		expect(compacting!.transientEvents.map((item) => item.event.type))
			.toContain("compaction_start");

		await settled(replies.messages, "c1");
		const compactionEntry = session.entries.at(-1);
		expect(compactionEntry?.type).toBe("compaction");
		const completed = completionOf(replies.messages, "c1");
		if (completed?.command !== "session.compact")
			throw new Error("expected a session.compact completion");
		expect(completed.result.compacted).toBe(true);
		expect(completed.result.entryId).toBe(compactionEntry!.id);
		expect(completed.result.tokensBefore).toBeGreaterThanOrEqual(0);
		expect(
			agentEvents(client.messages).map((envelope) => envelope.event.type),
		).toEqual(expect.arrayContaining(["compaction_start", "compaction_end"]));
		expect(host.snapshot().status).toBe("idle");
		expect(host.snapshot().entries.at(-1)?.type).toBe("compaction");
	});

	it("completes a no-op compact with compacted: false and no events", async () => {
		const { host } = await createHost(["unused"]);
		const client = collector();
		host.attach(client.sink);
		host.handle({ type: "session.compact", requestId: "c1" }, client.sink);
		await settled(client.messages, "c1");
		const completed = completionOf(client.messages, "c1");
		if (completed?.command !== "session.compact")
			throw new Error("expected a session.compact completion");
		expect(completed.result).toEqual({ compacted: false });
		expect(agentEvents(client.messages)).toHaveLength(0);
		expect(host.snapshot().status).toBe("idle");
	});

	it("close aborts the active run and waits for idle", async () => {
		const { session, host } = await createHost(
			["another long streaming answer so close lands mid-run"],
			{ delayMs: 10 },
		);
		const client = collector();
		host.attach(client.sink);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "go" },
			replies.sink,
		);
		await vi.waitFor(() => {
			expect(
				agentEvents(client.messages).some(
					(envelope) => envelope.event.type === "message_update",
				),
			).toBe(true);
		});
		await host.close();
		expect(session.state.isStreaming).toBe(false);
		expect(session.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "aborted" });
		expect(host.snapshot().status).toBe("idle");
		expect(completionOf(replies.messages, "r1")).toBeDefined();
	});

	it("detach alone does not abort the active run", async () => {
		const { session, host } = await createHost(["short answer"]);
		const client = collector();
		const detach = host.attach(client.sink);
		const replies = collector();
		host.handle(
			{ type: "prompt.submit", requestId: "r1", prompt: "go" },
			replies.sink,
		);
		detach();
		await settled(replies.messages, "r1");
		expect(session.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
		expect(agentEvents(client.messages)).toHaveLength(0);
	});
});

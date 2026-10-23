import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeStreamFn } from "@mini-agent/ai";
import { AgentSession } from "@mini-agent/core";
import { decodeServerMessage } from "@mini-agent/protocol";
import type {
	AgentEventEnvelope,
	ClientCommand,
	ServerMessage,
	SessionSnapshot,
} from "@mini-agent/protocol";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../src/session-host.ts";
import { startAgentWebSocketServer } from "../src/websocket-server.ts";
import type { AgentWebSocketServerHandle } from "../src/websocket-server.ts";

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

interface Setup {
	host: SessionHost;
	server: AgentWebSocketServerHandle;
}

async function setup(
	script: string[],
	options: { delayMs?: number } = {},
): Promise<Setup> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-ws-"));
	directories.push(directory);
	const session = await AgentSession.create({
		directory,
		system: "test system",
		streamFn: createFakeStreamFn(script, { delayMs: options.delayMs }),
	});
	const host = new SessionHost(session);
	const server = await startAgentWebSocketServer({ runtime: host, port: 0 });
	cleanups.push(async () => {
		await server.close();
		await host.close();
	});
	return { host, server };
}

// 真实 ws client：所有 incoming 先过 decodeServerMessage，wire 不合规直接记入 failures。
class TestClient {
	readonly socket: WebSocket;
	readonly messages: ServerMessage[] = [];
	readonly failures: string[] = [];

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (data) => {
			const decoded = decodeServerMessage(data.toString());
			if (!decoded.ok) this.failures.push(decoded.error.message);
			else this.messages.push(decoded.value);
		});
		// open 之后的 socket 错误由测试显式断言；不让它变成 unhandled error。
		socket.on("error", () => {});
	}

	static async connect(
		url: string,
		headers?: Record<string, string>,
	): Promise<TestClient> {
		const socket = new WebSocket(url, headers ? { headers } : undefined);
		const client = new TestClient(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", (error) => reject(error));
		});
		return client;
	}

	send(command: ClientCommand): void {
		this.socket.send(JSON.stringify(command));
	}

	sendRaw(raw: string): void {
		this.socket.send(raw);
	}

	close(): void {
		this.socket.close();
	}
}

function agentEvents(messages: ServerMessage[]): AgentEventEnvelope[] {
	return messages.flatMap((message) =>
		message.type === "agent.event" ? [message.envelope] : []
	);
}

async function waitFor(
	client: TestClient,
	predicate: (message: ServerMessage) => boolean,
	timeoutMs = 1000,
): Promise<void> {
	await vi.waitFor(() => {
		expect(client.messages.some(predicate)).toBe(true);
	}, { timeout: timeoutMs });
}

function snapshotOf(client: TestClient): SessionSnapshot {
	const message = client.messages.find((m) => m.type === "session.snapshot");
	if (message?.type !== "session.snapshot")
		throw new Error("expected a session.snapshot message");
	return message.snapshot;
}

describe("websocket happy path", () => {
	it("greets with server.ready then session.snapshot and streams a full run", async () => {
		const { server } = await setup(["hello world"]);
		const client = await TestClient.connect(server.url);
		await waitFor(client, (m) => m.type === "session.snapshot");

		expect(client.messages[0]?.type).toBe("server.ready");
		const ready = client.messages[0];
		if (ready?.type !== "server.ready") throw new Error("expected server.ready");
		expect(ready.protocolVersion).toBe(1);
		expect(ready.capabilities).toEqual(expect.arrayContaining([
			"journal_replay",
			"streaming_messages",
			"tool_timeline",
			"abort_run",
			"manual_compaction",
			"token_usage",
		]));
		expect(client.messages[1]?.type).toBe("session.snapshot");
		expect(snapshotOf(client).status).toBe("idle");

		client.send({ type: "prompt.submit", requestId: "r1", prompt: "say hi" });
		await waitFor(client, (m) => m.type === "command.completed");

		const acceptedAt = client.messages.findIndex(
			(m) => m.type === "command.accepted",
		);
		const firstEventAt = client.messages.findIndex(
			(m) => m.type === "agent.event",
		);
		expect(acceptedAt).toBeGreaterThanOrEqual(2);
		expect(firstEventAt).toBeGreaterThan(acceptedAt);

		const envelopes = agentEvents(client.messages);
		expect(envelopes.length).toBeGreaterThan(0);
		expect(envelopes.at(-1)?.event.type).toBe("agent_end");
		expect(envelopes.map((envelope) => envelope.sequence))
			.toEqual(envelopes.map((_, index) => index));

		expect(client.messages.at(-1)).toMatchObject({
			type: "command.completed",
			requestId: "r1",
			command: "prompt.submit",
		});
		expect(client.failures).toEqual([]);
	});
});

describe("malformed input", () => {
	it("replies INVALID_JSON and keeps the connection usable", async () => {
		const { server } = await setup(["still alive"]);
		const client = await TestClient.connect(server.url);
		await waitFor(client, (m) => m.type === "session.snapshot");

		client.sendRaw("{not json");
		await waitFor(client, (m) => m.type === "protocol.error");
		expect(client.messages.find((m) => m.type === "protocol.error"))
			.toMatchObject({ code: "INVALID_JSON" });

		// 同一连接的下一条合法 command 仍被正常处理。
		client.send({ type: "prompt.submit", requestId: "r1", prompt: "ping" });
		await waitFor(client, (m) => m.type === "command.completed");
		expect(client.messages.some(
			(m) => m.type === "command.accepted" && m.requestId === "r1",
		)).toBe(true);
	});

	it("replies INVALID_MESSAGE for invalid shapes and blank prompts", async () => {
		const { server } = await setup(["unused"]);
		const client = await TestClient.connect(server.url);
		await waitFor(client, (m) => m.type === "session.snapshot");

		client.sendRaw(JSON.stringify({
			type: "prompt.submit", requestId: "r1", prompt: "   ",
		}));
		client.sendRaw(JSON.stringify({ type: "prompt.submit", prompt: "no id" }));
		client.sendRaw(JSON.stringify(["not", "an", "object"]));
		await vi.waitFor(() => {
			expect(
				client.messages.filter((m) => m.type === "protocol.error"),
			).toHaveLength(3);
		});
		for (const message of client.messages) {
			if (message.type === "protocol.error")
				expect(message.code).toBe("INVALID_MESSAGE");
		}
	});

	it("does not call SessionHost for unknown protocol messages", async () => {
		const { host, server } = await setup(["unused"]);
		const handle = vi.spyOn(host, "handle");
		const client = await TestClient.connect(server.url);
		await waitFor(client, (m) => m.type === "session.snapshot");

		client.sendRaw(JSON.stringify({ type: "session.fork", requestId: "u1" }));
		await waitFor(client, (m) => m.type === "protocol.error");
		expect(client.messages.find((m) => m.type === "protocol.error"))
			.toMatchObject({ code: "INVALID_MESSAGE" });
		expect(handle).not.toHaveBeenCalled();
	});
});

describe("upgrade and payload boundaries", () => {
	it("rejects upgrades on a non-/agent path", async () => {
		const { server } = await setup(["unused"]);
		await expect(
			TestClient.connect(server.url.replace(/\/agent$/, "/other")),
		).rejects.toThrow("Unexpected server response: 404");
	});

	it("rejects a non-localhost Origin", async () => {
		const { server } = await setup(["unused"]);
		await expect(
			TestClient.connect(server.url, { Origin: "https://example.com" }),
		).rejects.toThrow("Unexpected server response: 403");
	});

	it("allows localhost origins and clients without an Origin header", async () => {
		const { server } = await setup(["unused"]);
		const browser = await TestClient.connect(server.url, {
			Origin: "http://localhost:5173",
		});
		await waitFor(browser, (m) => m.type === "server.ready");
		const cli = await TestClient.connect(server.url);
		await waitFor(cli, (m) => m.type === "server.ready");
	});

	it("closes sockets that exceed the payload limit and keeps serving", async () => {
		const { server } = await setup(["unused"]);
		const greedy = await TestClient.connect(server.url);
		await waitFor(greedy, (m) => m.type === "server.ready");

		const closed = new Promise<number>((resolve) => {
			greedy.socket.once("close", (code) => resolve(code));
		});
		greedy.sendRaw("x".repeat(65537));
		expect(await closed).toBe(1009);

		const next = await TestClient.connect(server.url);
		await waitFor(next, (m) => m.type === "server.ready");
	});
});

describe("mid-run reconnect", () => {
	it("keeps the run alive across disconnects and backfills via snapshot", async () => {
		// 320 个 delta × 10ms：A 断线、B 重连都落在 run 进行中。
		const { host, server } = await setup(["x".repeat(320)], { delayMs: 10 });

		const a = await TestClient.connect(server.url);
		await waitFor(a, (m) => m.type === "session.snapshot");
		a.send({ type: "prompt.submit", requestId: "r1", prompt: "stream please" });
		await waitFor(a, (m) =>
			m.type === "agent.event" && m.envelope.event.type === "message_update"
		);
		const aSeen = agentEvents(a.messages).length;
		a.close();

		// 断线不 abort：B 连接时 run 仍在进行，snapshot 停在 run 前 leaf。
		const b = await TestClient.connect(server.url);
		await waitFor(b, (m) => m.type === "session.snapshot");
		const snapshot = snapshotOf(b);
		expect(snapshot.status).toBe("running");
		expect(snapshot.entries.some((entry) => entry.type === "submission"))
			.toBe(false);
		// transientEvents 含 A 错过的当前 run 前缀：从 agent_start 起、含流式 update。
		expect(snapshot.transientEvents.length).toBeGreaterThanOrEqual(aSeen);
		expect(snapshot.transientEvents[0]?.event.type).toBe("agent_start");
		expect(snapshot.transientEvents.some(
			(envelope) => envelope.event.type === "message_update",
		)).toBe(true);
		snapshot.transientEvents.forEach((envelope, index) => {
			expect(envelope.sequence).toBe(index);
		});
		expect(snapshot.latestSequence)
			.toBe(snapshot.transientEvents.at(-1)!.sequence);

		// B 无缝接 live events：第一条紧跟 snapshot，无重复无缺口，直到 agent_end。
		// 延迟脚本需要几秒跑完整个 run，默认 1s 的 waitFor 等不到。
		await waitFor(b, (m) =>
			m.type === "agent.event" && m.envelope.event.type === "agent_end",
			10000
		);
		const live = agentEvents(b.messages);
		expect(live.length).toBeGreaterThan(0);
		expect(live[0]!.sequence).toBe(snapshot.latestSequence + 1);
		for (let index = 1; index < live.length; index++) {
			expect(live[index]!.sequence).toBe(live[index - 1]!.sequence + 1);
		}
		// provider 在 A 断开后继续：B 的 live 里仍有新的 message_update。
		expect(live.some((envelope) => envelope.event.type === "message_update"))
			.toBe(true);

		// settle 之后再连接：snapshot 为完整 idle journal，transientEvents 清空。
		await vi.waitFor(() => expect(host.snapshot().status).toBe("idle"), {
			timeout: 10000,
		});
		const c = await TestClient.connect(server.url);
		await waitFor(c, (m) => m.type === "session.snapshot");
		const settled = snapshotOf(c);
		expect(settled.status).toBe("idle");
		expect(settled.transientEvents).toEqual([]);
		expect(settled.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
	}, 20000);
});

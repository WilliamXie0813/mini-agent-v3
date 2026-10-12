import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	decodeServerMessage,
} from "@mini-agent/protocol";
import type { ServerMessage } from "@mini-agent/protocol";
import {
	startAgentWebSocketServer,
} from "../src/websocket-server.ts";
import type {
	AgentWebSocketServerHandle,
} from "../src/websocket-server.ts";

type Predicate = (message: ServerMessage) => boolean;

const servers: AgentWebSocketServerHandle[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const server of servers.splice(0)) await server.close();
});

async function start(
	maxPayloadBytes?: number,
): Promise<AgentWebSocketServerHandle> {
	const server = await startAgentWebSocketServer({
		port: 0,
		...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
	});
	servers.push(server);
	return server;
}

async function connect(
	url: string,
	options: WebSocket.ClientOptions = {},
): Promise<{
	socket: WebSocket;
	messages: ServerMessage[];
	waitFor: (predicate: Predicate) => Promise<ServerMessage>;
}> {
	const socket = new WebSocket(url, options);
	clients.push(socket);
	const messages: ServerMessage[] = [];
	const waiters = new Set<{
		predicate: Predicate;
		resolve: (message: ServerMessage) => void;
	}>();
	socket.on("message", (data) => {
		const decoded = decodeServerMessage(data.toString());
		if (!decoded.ok)
			throw new Error(`invalid server message: ${decoded.error.message}`);
		messages.push(decoded.value);
		for (const waiter of waiters) {
			if (!waiter.predicate(decoded.value)) continue;
			waiters.delete(waiter);
			waiter.resolve(decoded.value);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return {
		socket,
		messages,
		waitFor: (predicate) => {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const waiter = { predicate, resolve };
				waiters.add(waiter);
				setTimeout(() => {
					if (!waiters.delete(waiter)) return;
					reject(new Error("timed out waiting for websocket message"));
				}, 2_000);
			});
		},
	};
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		socket.once("close", (code, reason) => {
			resolve({ code, reason: reason.toString() });
		});
	});
}

describe("startAgentWebSocketServer", () => {
	it("sends ready, accepts a run, then streams events before settling", async () => {
		const server = await start();
		const client = await connect(server.url);
		const ready = await client.waitFor(
			(message) => message.type === "server.ready",
		);
		expect(ready.type).toBe("server.ready");

		client.socket.send(JSON.stringify({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "streaming-text",
			prompt: "show the stream",
		}));
		await client.waitFor(
			(message) =>
				message.type === "run.settled" &&
				message.outcome === "completed",
		);

		const accepted = client.messages.findIndex(
			(message) => message.type === "run.accepted",
		);
		const firstEvent = client.messages.findIndex(
			(message) => message.type === "agent.event",
		);
		expect(accepted).toBeGreaterThan(-1);
		expect(firstEvent).toBeGreaterThan(accepted);
	});

	it("closes a second simultaneous client without replacing the first", async () => {
		const server = await start();
		const first = await connect(server.url);
		await first.waitFor((message) => message.type === "server.ready");
		const second = new WebSocket(server.url);
		clients.push(second);
		const closed = waitForClose(second);

		await new Promise<void>((resolve, reject) => {
			second.once("open", resolve);
			second.once("error", reject);
		});

		expect(await closed).toEqual({
			code: 1013,
			reason: "Only one client is supported.",
		});
		expect(first.socket.readyState).toBe(WebSocket.OPEN);
	});

	it("reports invalid input and continues handling later commands", async () => {
		const server = await start();
		const client = await connect(server.url);
		await client.waitFor((message) => message.type === "server.ready");

		client.socket.send("{");
		const invalidJson = await client.waitFor(
			(message) =>
				message.type === "protocol.error" &&
				message.code === "INVALID_JSON",
		);
		expect(invalidJson.type).toBe("protocol.error");

		client.socket.send(JSON.stringify({
			type: "run.pause",
			requestId: "bad-shape",
		}));
		await client.waitFor(
			(message) =>
				message.type === "protocol.error" &&
				message.code === "INVALID_MESSAGE",
		);

		client.socket.send(JSON.stringify({
			type: "workspace.reset",
			requestId: "reset-1",
		}));
		expect(await client.waitFor(
			(message) =>
				message.type === "workspace.reset" &&
				message.requestId === "reset-1",
		)).toMatchObject({ type: "workspace.reset" });
	});

	it("rejects upgrades outside the agent path", async () => {
		const server = await start();
		const socket = new WebSocket(server.url.replace("/agent", "/wrong"));
		clients.push(socket);

		const status = await new Promise<number>((resolve, reject) => {
			socket.once("unexpected-response", (_request, response) => {
				resolve(response.statusCode ?? 0);
			});
			socket.once("error", reject);
		});

		expect(status).toBe(404);
	});

	it("rejects browser origins outside localhost", async () => {
		const server = await start();
		const socket = new WebSocket(server.url, {
			origin: "https://example.com",
		});
		clients.push(socket);

		const status = await new Promise<number>((resolve, reject) => {
			socket.once("unexpected-response", (_request, response) => {
				resolve(response.statusCode ?? 0);
			});
			socket.once("error", reject);
		});

		expect(status).toBe(403);
	});

	it("closes an oversized client but remains available", async () => {
		const server = await start(64);
		const first = await connect(server.url);
		await first.waitFor((message) => message.type === "server.ready");
		const closed = waitForClose(first.socket);
		first.socket.send("x".repeat(65));

		expect((await closed).code).toBe(1009);

		const second = await connect(server.url);
		expect(await second.waitFor(
			(message) => message.type === "server.ready",
		)).toMatchObject({ type: "server.ready" });
	});

	it("starts a fresh session after a client disconnects mid-run", async () => {
		const server = await start();
		const first = await connect(server.url);
		await first.waitFor((message) => message.type === "server.ready");
		first.socket.send(JSON.stringify({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "abort-lifecycle",
			prompt: "disconnect this run",
		}));
		await first.waitFor(
			(message) =>
				message.type === "agent.event" &&
				message.event.type === "message_update",
		);
		const firstClosed = waitForClose(first.socket);
		first.socket.close();
		await firstClosed;

		const second = await connect(server.url);
		await second.waitFor((message) => message.type === "server.ready");
		second.socket.send(JSON.stringify({
			type: "workspace.reset",
			requestId: "reset-2",
		}));
		await second.waitFor(
			(message) =>
				message.type === "workspace.reset" &&
				message.requestId === "reset-2",
		);

		expect(second.messages.some(
			(message) =>
				message.type === "agent.event" ||
				message.type === "run.settled",
		)).toBe(false);
	});
});

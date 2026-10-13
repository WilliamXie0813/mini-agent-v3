import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@mini-agent/protocol";
import {
	createProtocolClient,
} from "../src/protocol-client.ts";
import type { ConnectionState } from "../src/state/types.ts";

type EventType = "open" | "message" | "close";

class FakeWebSocket {
	readyState = 0;
	readonly sent: string[] = [];
	private listeners = new Map<EventType, Array<(event: unknown) => void>>();

	addEventListener(type: EventType, listener: (event: unknown) => void): void {
		const current = this.listeners.get(type) ?? [];
		current.push(listener);
		this.listeners.set(type, current);
	}

	send(message: string): void {
		this.sent.push(message);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	message(data: string): void {
		this.emit("message", { data });
	}

	serverClose(): void {
		this.close();
	}

	private emit(type: EventType, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function harness() {
	const sockets: FakeWebSocket[] = [];
	const states: ConnectionState[] = [];
	const messages: ServerMessage[] = [];
	const client = createProtocolClient({
		url: "ws://localhost/agent",
		onMessage: (message) => messages.push(message),
		onConnectionChange: (state) => states.push(state),
		createSocket: () => {
			const socket = new FakeWebSocket();
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
	return { client, sockets, states, messages };
}

describe("createProtocolClient", () => {
	it("reports connecting then connected", () => {
		const { client, sockets, states } = harness();

		client.connect();
		expect(states).toEqual(["connecting"]);
		sockets[0].open();
		expect(states).toEqual(["connecting", "connected"]);
	});

	it("decodes valid server messages", () => {
		const { client, sockets, messages } = harness();
		client.connect();
		sockets[0].open();
		const ready = {
			type: "server.ready",
			protocolVersion: 1,
			capabilities: ["demo_scenarios"],
			scenarios: [],
		};

		sockets[0].message(JSON.stringify(ready));

		expect(messages).toEqual([ready]);
	});

	it.each([
		"{",
		JSON.stringify({ type: "server.pong" }),
	])("marks invalid server data incompatible without forwarding it", (raw) => {
		const { client, sockets, messages, states } = harness();
		client.connect();
		sockets[0].open();

		sockets[0].message(raw);

		expect(messages).toEqual([]);
		expect(states.at(-1)).toBe("incompatible");
	});

	it("throws instead of dropping a command before open", () => {
		const { client } = harness();
		client.connect();

		expect(() => client.send({
			type: "workspace.reset",
			requestId: "request-1",
		})).toThrow("websocket is not open");
	});

	it("serializes commands after open", () => {
		const { client, sockets } = harness();
		client.connect();
		sockets[0].open();

		client.send({
			type: "run.abort",
			requestId: "request-1",
		});

		expect(sockets[0].sent).toEqual([
			JSON.stringify({ type: "run.abort", requestId: "request-1" }),
		]);
	});

	it("reports disconnect once and does not reconnect", () => {
		const createSocket = vi.fn(() => new FakeWebSocket() as unknown as WebSocket);
		const states: ConnectionState[] = [];
		const client = createProtocolClient({
			url: "ws://localhost/agent",
			onMessage: () => {},
			onConnectionChange: (state) => states.push(state),
			createSocket,
		});
		client.connect();
		const socket = createSocket.mock.results[0].value as unknown as FakeWebSocket;
		socket.open();

		socket.serverClose();

		expect(states).toEqual(["connecting", "connected", "disconnected"]);
		expect(createSocket).toHaveBeenCalledTimes(1);
	});
});

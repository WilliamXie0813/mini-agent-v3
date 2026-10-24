import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "@mini-agent/protocol";

import {
	createProtocolClient,
	type ProtocolClientOptions,
} from "../src/protocol-client.ts";

const READY_MESSAGE: ServerMessage = {
	type: "server.ready",
	protocolVersion: 1,
	capabilities: ["journal_replay"],
};

const SNAPSHOT_MESSAGE: ServerMessage = {
	type: "session.snapshot",
	snapshot: {
		sessionId: "s1",
		leafId: null,
		status: "idle",
		entries: [],
		transientEvents: [],
		latestSequence: 0,
	},
};

// 最小 WebSocket stub：record 发出的帧，由测试显式触发 open/message/close。
class FakeSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	readonly url: string;
	readonly sent: string[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}

	receive(data: unknown): void {
		this.onmessage?.({ data });
	}

	emitClose(): void {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.emitClose();
	}
}

function setup(overrides: Partial<ProtocolClientOptions> = {}) {
	const sockets: FakeSocket[] = [];
	const onMessage = vi.fn();
	const onConnectionChange = vi.fn();
	const client = createProtocolClient({
		url: "ws://test/agent",
		onMessage,
		onConnectionChange,
		createSocket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
		...overrides,
	});
	return { client, sockets, onMessage, onConnectionChange };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createProtocolClient", () => {
	it("reports connecting on connect() and connected when the socket opens", () => {
		const { client, sockets, onConnectionChange } = setup();
		client.connect();
		expect(onConnectionChange).toHaveBeenNthCalledWith(1, "connecting");
		sockets[0].open();
		expect(onConnectionChange).toHaveBeenNthCalledWith(2, "connected");
		expect(sockets[0].url).toBe("ws://test/agent");
	});

	it("decodes incoming JSON and forwards server messages", () => {
		const { client, sockets, onMessage } = setup();
		client.connect();
		sockets[0].open();
		sockets[0].receive(JSON.stringify(READY_MESSAGE));
		sockets[0].receive(JSON.stringify(SNAPSHOT_MESSAGE));
		expect(onMessage).toHaveBeenCalledWith(READY_MESSAGE);
		expect(onMessage).toHaveBeenCalledWith(SNAPSHOT_MESSAGE);
	});

	it("marks the connection incompatible on malformed JSON without calling onMessage", () => {
		const { client, sockets, onMessage, onConnectionChange } = setup();
		client.connect();
		sockets[0].open();
		onConnectionChange.mockClear();
		sockets[0].receive("{ not json");
		expect(onConnectionChange).toHaveBeenCalledWith("incompatible");
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("marks the connection incompatible on unsupported messages and versions", () => {
		const { client, sockets, onMessage, onConnectionChange } = setup();
		client.connect();
		sockets[0].open();
		onConnectionChange.mockClear();
		sockets[0].receive(JSON.stringify({ type: "server.hello" }));
		sockets[0].receive(
			JSON.stringify({ type: "server.ready", protocolVersion: 99, capabilities: [] }),
		);
		expect(onConnectionChange).toHaveBeenCalledTimes(2);
		expect(onConnectionChange).toHaveBeenNthCalledWith(1, "incompatible");
		expect(onConnectionChange).toHaveBeenNthCalledWith(2, "incompatible");
		expect(onMessage).not.toHaveBeenCalled();
		sockets[0].receive(JSON.stringify(READY_MESSAGE));
		expect(onMessage).toHaveBeenCalledWith(READY_MESSAGE);
	});

	it("reconnects after an unexpected close with the server handshake on the new socket", () => {
		vi.useFakeTimers();
		const { client, sockets, onMessage, onConnectionChange } = setup();
		client.connect();
		sockets[0].open();
		sockets[0].emitClose();
		expect(onConnectionChange).toHaveBeenLastCalledWith("reconnecting");
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(249);
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(2);
		sockets[1].open();
		expect(onConnectionChange).toHaveBeenLastCalledWith("connected");
		sockets[1].receive(JSON.stringify(READY_MESSAGE));
		sockets[1].receive(JSON.stringify(SNAPSHOT_MESSAGE));
		expect(onMessage).toHaveBeenCalledWith(READY_MESSAGE);
		expect(onMessage).toHaveBeenCalledWith(SNAPSHOT_MESSAGE);
	});

	it("cycles reconnect delays through [250, 500, 1000, 2000] and clamps", () => {
		vi.useFakeTimers();
		const { client, sockets } = setup();
		client.connect();
		sockets[0].open();
		const delays = [250, 500, 1000, 2000, 2000];
		for (let attempt = 0; attempt < delays.length; attempt += 1) {
			sockets[attempt].emitClose();
			vi.advanceTimersByTime(delays[attempt]);
			expect(sockets).toHaveLength(attempt + 2);
			sockets[attempt + 1].open();
		}
	});

	it("retry() replaces an active connection without scheduling an automatic reconnect", () => {
		vi.useFakeTimers();
		const { client, sockets, onConnectionChange } = setup();
		client.connect();
		sockets[0].open();
		onConnectionChange.mockClear();
		client.retry();
		expect(onConnectionChange).toHaveBeenCalledWith("connecting");
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(10_000);
		expect(sockets).toHaveLength(2);
	});

	it("explicit close() cancels the reconnect timer and reports disconnected", () => {
		vi.useFakeTimers();
		const { client, sockets, onConnectionChange } = setup();
		client.connect();
		sockets[0].open();
		sockets[0].emitClose();
		expect(onConnectionChange).toHaveBeenLastCalledWith("reconnecting");
		client.close();
		expect(onConnectionChange).toHaveBeenLastCalledWith("disconnected");
		vi.advanceTimersByTime(10_000);
		expect(sockets).toHaveLength(1);
	});

	it("throws when sending without an open socket", () => {
		const { client, sockets } = setup();
		const command = { type: "run.abort", requestId: "r1" } as const;
		expect(() => client.send(command)).toThrow("WebSocket is not connected");
		client.connect();
		expect(() => client.send(command)).toThrow("WebSocket is not connected");
		sockets[0].open();
		sockets[0].emitClose();
		expect(() => client.send(command)).toThrow("WebSocket is not connected");
	});

	it("serializes outgoing commands as JSON", () => {
		const { client, sockets } = setup();
		client.connect();
		sockets[0].open();
		client.send({ type: "session.compact", requestId: "r9" });
		expect(sockets[0].sent).toEqual([
			JSON.stringify({ type: "session.compact", requestId: "r9" }),
		]);
	});
});

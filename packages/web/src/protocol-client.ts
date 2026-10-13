import {
	decodeServerMessage,
} from "@mini-agent/protocol";
import type {
	ClientCommand,
	ServerMessage,
} from "@mini-agent/protocol";
import type { ConnectionState } from "./state/types.ts";

export interface ProtocolClientOptions {
	url: string;
	onMessage(message: ServerMessage): void;
	onConnectionChange(state: ConnectionState): void;
	createSocket?: (url: string) => WebSocket;
}

export interface ProtocolClient {
	connect(): void;
	send(command: ClientCommand): void;
	close(): void;
}

export function createProtocolClient(
	options: ProtocolClientOptions,
): ProtocolClient {
	let socket: WebSocket | undefined;
	let lastConnection: ConnectionState | undefined;
	let incompatible = false;
	const report = (state: ConnectionState) => {
		if (state === lastConnection) return;
		lastConnection = state;
		options.onConnectionChange(state);
	};

	return {
		connect() {
			if (socket) throw new Error("protocol client connects only once");
			report("connecting");
			socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
				options.url,
			);
			socket.addEventListener("open", () => report("connected"));
			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") {
					incompatible = true;
					report("incompatible");
					socket?.close();
					return;
				}
				const decoded = decodeServerMessage(event.data);
				if (!decoded.ok) {
					incompatible = true;
					report("incompatible");
					socket?.close();
					return;
				}
				options.onMessage(decoded.value);
			});
			socket.addEventListener("close", () => {
				if (!incompatible) report("disconnected");
			});
		},
		send(command) {
			if (!socket || socket.readyState !== 1)
				throw new Error("websocket is not open");
			socket.send(JSON.stringify(command));
		},
		close() {
			if (!socket) return;
			socket.close();
			if (!incompatible) report("disconnected");
		},
	};
}

export function browserWebSocketUrl(
	location: Pick<Location, "protocol" | "host"> = window.location,
): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/agent`;
}

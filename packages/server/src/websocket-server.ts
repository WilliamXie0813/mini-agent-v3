import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
	WebSocket,
	WebSocketServer,
} from "ws";
import { decodeClientCommand } from "@mini-agent/protocol";
import type { ServerMessage } from "@mini-agent/protocol";
import { createDemoScenarioRegistry } from "./scenarios.ts";
import { SessionController } from "./session-controller.ts";

export interface AgentWebSocketServerOptions {
	host?: "127.0.0.1";
	port?: number;
	maxPayloadBytes?: number;
}

export interface AgentWebSocketServerHandle {
	url: string;
	close(): Promise<void>;
}

export async function startAgentWebSocketServer(
	options: AgentWebSocketServerOptions = {},
): Promise<AgentWebSocketServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8787;
	const maxPayload = options.maxPayloadBytes ?? 65_536;
	const server = createServer((_request, response) => {
		response.writeHead(404).end();
	});
	const sockets = new WebSocketServer({ noServer: true, maxPayload });
	let activeSocket: WebSocket | undefined;

	server.on("upgrade", (request, socket, head) => {
		if (pathOf(request) !== "/agent") {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}
		if (!originAllowed(request.headers.origin)) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (webSocket) => {
			sockets.emit("connection", webSocket, request);
		});
	});

	sockets.on("connection", (socket) => {
		socket.on("error", () => socket.terminate());
		if (
			activeSocket &&
			activeSocket.readyState !== WebSocket.CLOSED
		) {
			socket.close(1013, "Only one client is supported.");
			return;
		}
		activeSocket = socket;
		const controller = new SessionController({
			send: (message) => send(socket, message),
			scenarios: createDemoScenarioRegistry(),
		});
		void controller.sendReady().catch((error) => {
			failSocket(socket, error);
		});
		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				sendSafely(socket, {
					type: "protocol.error",
					code: "INVALID_MESSAGE",
					message: "Binary websocket messages are not supported.",
				});
				return;
			}
			const decoded = decodeClientCommand(data.toString());
			if (!decoded.ok) {
				sendSafely(socket, {
					type: "protocol.error",
					code: decoded.error.code,
					message: decoded.error.message,
				});
				return;
			}
			void controller.handle(decoded.value).catch((error) => {
				failSocket(socket, error);
			});
		});
		socket.once("close", () => {
			controller.disconnect();
			if (activeSocket === socket) activeSocket = undefined;
		});
	});

	await listen(server, host, port);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("websocket server did not expose a TCP address");
	return {
		url: `ws://${host}:${address.port}/agent`,
		close: async () => {
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			sockets.close();
		},
	};
}

function listen(
	server: ReturnType<typeof createServer>,
	host: string,
	port: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function pathOf(request: IncomingMessage): string {
	return new URL(request.url ?? "/", "http://localhost").pathname;
}

function originAllowed(origin: string | undefined): boolean {
	if (origin === undefined) return true;
	try {
		const hostname = new URL(origin).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
}

function send(socket: WebSocket, message: ServerMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		if (socket.readyState !== WebSocket.OPEN) {
			reject(new Error("websocket is not open"));
			return;
		}
		socket.send(JSON.stringify(message), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function failSocket(socket: WebSocket, error: unknown): void {
	if (socket.readyState !== WebSocket.OPEN) return;
	void send(socket, {
		type: "protocol.error",
		code: "SERVER_ERROR",
		message: error instanceof Error ? error.message : String(error),
	}).then(
		() => socket.close(1011, "Server error."),
		() => socket.terminate(),
	);
}

function sendSafely(socket: WebSocket, message: ServerMessage): void {
	void send(socket, message).catch(() => socket.terminate());
}

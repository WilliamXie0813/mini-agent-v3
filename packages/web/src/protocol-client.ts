import { decodeServerMessage } from "@mini-agent/protocol";
import type { ClientCommand, ServerMessage } from "@mini-agent/protocol";

import type { AppState } from "./state/types.ts";

export interface ProtocolClientOptions {
	url: string;
	onMessage(message: ServerMessage): void;
	onConnectionChange(state: AppState["connection"]): void;
	createSocket?: (url: string) => WebSocket;
	reconnectDelaysMs?: readonly number[];
}

export interface ProtocolClient {
	connect(): void;
	retry(): void;
	send(command: ClientCommand): void;
	close(): void;
}

// 重连退避：按序循环，最后一次失败后停在末档（2000ms）。
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

// 浏览器页面 http → ws://<host>/agent，https → wss://<host>/agent。
export function resolveAgentSocketUrl(location: Location): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/agent`;
}

// socket 生命周期与重连 timer 都由 client 私有：同时最多一个 socket、一个 timer。
// 每次 open 不发 sync command——server 的 ready + snapshot 就是握手。
export function createProtocolClient(
	options: ProtocolClientOptions,
): ProtocolClient {
	const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
	const createSocket =
		options.createSocket ?? ((url: string) => new WebSocket(url));
	let socket: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	let explicitClose = false;

	function clearReconnectTimer(): void {
		if (reconnectTimer !== undefined) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
	}

	function scheduleReconnect(): void {
		if (explicitClose) return;
		const delay = delays[Math.min(reconnectAttempt, delays.length - 1)] ?? 250;
		reconnectAttempt += 1;
		clearReconnectTimer();
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			openSocket();
		}, delay);
	}

	function openSocket(): void {
		const ws = createSocket(options.url);
		socket = ws;
		ws.onopen = () => {
			reconnectAttempt = 0;
			options.onConnectionChange("connected");
		};
		ws.onmessage = (event) => {
			const decoded = decodeServerMessage(event.data);
			if (!decoded.ok) {
				options.onConnectionChange("incompatible");
				return;
			}
			options.onMessage(decoded.value);
		};
		ws.onclose = () => {
			if (socket !== ws) return; // 过期 socket 的 close（如被替换后）不再驱动状态。
			socket = null;
			if (explicitClose) return;
			options.onConnectionChange("reconnecting");
			scheduleReconnect();
		};
		ws.onerror = () => {};
	}

	function releaseSocket(): void {
		const ws = socket;
		socket = null;
		if (!ws) return;
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		ws.close();
	}

	function startConnection(): void {
		explicitClose = false;
		reconnectAttempt = 0;
		clearReconnectTimer();
		releaseSocket();
		options.onConnectionChange("connecting");
		openSocket();
	}

	return {
		connect(): void {
			startConnection();
		},
		retry(): void {
			startConnection();
		},
		send(command: ClientCommand): void {
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				throw new Error("WebSocket is not connected");
			}
			socket.send(JSON.stringify(command));
		},
		close(): void {
			explicitClose = true;
			clearReconnectTimer();
			releaseSocket();
			options.onConnectionChange("disconnected");
		},
	};
}

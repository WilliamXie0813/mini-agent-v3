import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { decodeClientCommand, PROTOCOL_VERSION } from "@mini-agent/protocol";
import type { Capability, ServerMessage } from "@mini-agent/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { ServerMessageSink, SessionHost } from "./session-host.ts";

export interface AgentWebSocketServerOptions {
	runtime: SessionHost;
	host?: "127.0.0.1";
	port?: number;
	maxPayloadBytes?: number;
}

export interface AgentWebSocketServerHandle {
	url: string;
	close(): Promise<void>;
}

const AGENT_PATH = "/agent";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

const CAPABILITIES: Capability[] = [
	"journal_replay",
	"streaming_messages",
	"tool_timeline",
	"abort_run",
	"manual_compaction",
	"token_usage",
];

function isAgentPath(url: string | undefined): boolean {
	if (url === undefined) return false;
	try {
		return new URL(url, "http://127.0.0.1").pathname === AGENT_PATH;
	} catch {
		return false;
	}
}

// 浏览器 WebSocket 必带 Origin：只信本机页面（localhost/127.0.0.1），
// 挡住其他网站借浏览器连上本地 agent。无 Origin 的是 CLI/测试 client，放行。
function isAllowedOrigin(origin: string | undefined): boolean {
	if (origin === undefined) return true;
	try {
		const hostname = new URL(origin).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

// 拒绝 upgrade 必须显式写响应再销毁 socket：静默挂着会让客户端永远等握手。
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

// 单连接接线：先 server.ready 握手，再 attach（同步发 snapshot 并 flush 队列）。
// send 在非 OPEN 时抛错——SessionHost.deliver 捕获后只 detach 这个 client，
// 错误不会冒泡回 Agent listener；close/error 同样只 detach，绝不 abort run。
function handleConnection(runtime: SessionHost, socket: WebSocket): void {
	const send: ServerMessageSink = (message) => {
		if (socket.readyState !== WebSocket.OPEN)
			throw new Error("websocket is not open");
		socket.send(JSON.stringify(message));
	};
	send({
		type: "server.ready",
		protocolVersion: PROTOCOL_VERSION,
		capabilities: CAPABILITIES,
	});
	const detach = runtime.attach(send);
	socket.on("message", (data: RawData, isBinary: boolean) => {
		// 二进制帧没有 JSON 文本语义，与 invalid JSON 同一条错误路径。
		const decoded = decodeClientCommand(isBinary ? data : data.toString());
		if (!decoded.ok) {
			try {
				send({
					type: "protocol.error",
					code: decoded.error.code,
					message: decoded.error.message,
				});
			} catch {
				// socket 已坏：等 close 统一 detach。
			}
			return;
		}
		runtime.handle(decoded.value, send);
	});
	socket.on("close", detach);
	socket.on("error", detach);
}

// localhost WebSocket transport：只绑 127.0.0.1，path 固定 /agent。
// server 本身不解释协议内容——decode 失败回 protocol.error，合法 command 原样交给 runtime。
export function startAgentWebSocketServer(
	options: AgentWebSocketServerOptions,
): Promise<AgentWebSocketServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? DEFAULT_PORT;
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
	});
	// WebSocket 只走 upgrade；普通 HTTP 请求没有可说的，404 立即结束。
	const httpServer: Server = createServer((_request, response) => {
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});
	httpServer.on(
		"upgrade",
		(request: IncomingMessage, socket: Duplex, head: Buffer) => {
			if (!isAgentPath(request.url)) {
				rejectUpgrade(socket, 404, "Not Found");
				return;
			}
			if (!isAllowedOrigin(request.headers.origin)) {
				rejectUpgrade(socket, 403, "Forbidden");
				return;
			}
			wss.handleUpgrade(request, socket, head, (websocket) => {
				handleConnection(options.runtime, websocket);
			});
		},
	);
	return new Promise((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, () => {
			httpServer.removeListener("error", reject);
			const address = httpServer.address();
			if (address === null || typeof address === "string") {
				reject(new Error("websocket server has no bound port"));
				return;
			}
			let closed = false;
			resolve({
				url: `ws://${host}:${address.port}${AGENT_PATH}`,
				async close() {
					if (closed) return;
					closed = true;
					// 先 terminate 活着的 client（触发 close → detach），wss.close 等它们
					// 全部断开，最后才停 HTTP listener；不向 runtime 传任何 shutdown 语义。
					const drained = new Promise<void>((done) => wss.close(() => done()));
					for (const client of wss.clients) client.terminate();
					await drained;
					await new Promise<void>((done, fail) => {
						httpServer.close((error) => error ? fail(error) : done());
					});
				},
			});
		});
	});
}

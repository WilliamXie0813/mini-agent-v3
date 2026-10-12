import { startAgentWebSocketServer } from "./websocket-server.ts";

const server = await startAgentWebSocketServer();
console.log(`mini-agent server listening on ${server.url}`);

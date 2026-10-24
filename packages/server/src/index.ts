import { createRuntime } from "./create-runtime.ts";
import { loadSharedEnv } from "../../../scripts/load-shared-env.ts";
import { startAgentWebSocketServer } from "./websocket-server.ts";

// CLI 与 server 共享仓库根目录 .env；shell 显式设置的 env 仍然优先。
loadSharedEnv();

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--continue")) {
	throw new Error(
		"Unknown server arguments; the only supported option is --continue",
	);
}

const runtime = await createRuntime({ continueSession: args[0] === "--continue" });
const server = await startAgentWebSocketServer({ runtime });
console.log(`mini-agent server listening on ${server.url}`);

// 关闭顺序固定：先停 transport（断 client、拒新连接），再关 runtime
// （abort active run 并等 journal 落盘）。只防御一次重复信号。
let closing = false;
async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	try {
		await server.close();
		await runtime.close();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

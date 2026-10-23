import { createRuntime } from "./create-runtime.ts";
import { startAgentWebSocketServer } from "./websocket-server.ts";

// 本地开发的默认配置来自 cwd 的 .env（pnpm dev 时即 packages/server/.env）。
// loadEnvFile 不覆盖已有变量——shell 显式设置的 env 优先；没有 .env 不算错误。
try {
	process.loadEnvFile();
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

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

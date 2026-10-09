import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolDef, ToolResult } from "./tool.ts";

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// 模型给的路径相对工作目录解析；路径逃逸防护是阶段 11 的事。
export function createReadTool(): ToolDef<{ path: string; offset?: number; limit?: number }> {
	return {
		name: "read",
		description: "Read a file with 1-based line numbers, like cat -n. Supports offset/limit for large files.",
		replay: "safe",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file, relative to the working directory." },
				offset: { type: "number", description: "1-based line number to start from." },
				limit: { type: "number", description: "Maximum number of lines to return. Defaults to 200." },
			},
			required: ["path"],
		},
		execute: async ({ path, offset, limit }) => {
			let source: string;
			try {
				source = await readFile(path, "utf8");
			} catch (e) {
				// ENOENT 的系统文案不含「路径相对 cwd 解析」这个信息，模型读了自己写不出下一步。
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return err(`File not found: ${path}`);
				throw e;
			}
			// 末尾换行不产生一行——"a\n" 是一行不是两行，否则行号会漂移。
			const lines = source.split("\n");
			if (lines[lines.length - 1] === "") lines.pop();
			const start = Math.max((offset ?? 1) - 1, 0);
			const end = Math.min(start + (limit ?? 200), lines.length);
			const body = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`);
			// 截断提示只属于默认 200 行的隐式截断；显式给了 limit 就是模型自己要的范围。
			if (limit === undefined && end < lines.length) body.push(`[truncated: showing lines ${start + 1}-${end} of ${lines.length}]`);
			return { content: [{ type: "text", text: body.join("\n") }] };
		},
	};
}

export function createEditTool(): ToolDef<{ path: string; oldText: string; newText: string }> {
	return {
		name: "edit",
		description: "Replace a unique occurrence of oldText with newText in a file. Fails without writing if oldText is absent or appears more than once.",
		replay: "unsafe",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file, relative to the working directory." },
				oldText: { type: "string", description: "Exact text to replace, including whitespace. Must appear exactly once." },
				newText: { type: "string", description: "Replacement text, written literally." },
			},
			required: ["path", "oldText", "newText"],
		},
		execute: async ({ path, oldText, newText }) => {
			const before = await readFile(path, "utf8");
			const first = before.indexOf(oldText);
			// split 计数而非正则：oldText 里的 * / ( 会让正则炸掉。
			const count = first === -1 ? 0 : before.split(oldText).length - 1;
			// 错误文案给修复动作——读者是模型，它要知道下一步做什么。非唯一时不写文件。
			if (count === 0) return err(`oldText not found in ${path}. Read the file first; the text must match exactly, including whitespace.`);
			if (count > 1) return err(`oldText appears ${count} times in ${path}. Include more surrounding context so it is unique.`);
			// indexOf + 切片，不用 String.prototype.replace：$& / $' 等模式会被解释，newText 必须逐字写入。
			await writeFile(path, before.slice(0, first) + newText + before.slice(first + oldText.length), "utf8");
			return { content: [{ type: "text", text: `Edited ${path}.` }] };
		},
	};
}

const MAX_OUTPUT = 10_000;

export function createBashTool(options: { timeoutMs?: number } = {}): ToolDef<{ command: string }> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	return {
		name: "bash",
		description: "Run a shell command and return its stdout/stderr. Times out after 30 seconds by default.",
		replay: "unsafe",
		parameters: {
			type: "object",
			properties: { command: { type: "string", description: "Shell command to run." } },
			required: ["command"],
		},
		execute: (params, signal) => runShell(params.command, timeoutMs, signal),
	};
}

// spawn 内建 signal/timeout，不用手写 setTimeout+kill——手写会漏掉 close 事件的竞态。
function runShell(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, signal, timeout: timeoutMs, killSignal: "SIGKILL" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d; });
		child.stderr.on("data", (d: Buffer) => { stderr += d; });
		child.on("error", (e) => {
			// signal 触发的 abort 会先抛 AbortError；真正的结算走 close（那时 kill 已完成）。
			if (signal?.aborted && e.name === "AbortError") return;
			resolve(err(e.message));
		});
		// Windows + shell:true：cmd.exe 被杀后孙进程仍握着继承来的管道，close 要等它退出。
		// 直接子进程已死，剩下能写管道的只有孤儿孙进程——那正是要掐断的输出，主动断流让 close 到来。
		child.on("exit", () => { child.stdout.destroy(); child.stderr.destroy(); });
		child.on("close", (code, closeSignal) => {
			const parts: string[] = [];
			if (stdout) parts.push(`[stdout]\n${truncate(stdout)}`);
			if (stderr) parts.push(`[stderr]\n${truncate(stderr)}`);
			// code 为 null 且 signal 有值：超时或外部 abort 杀的，不是命令自己退出。
			if (code === null && closeSignal) {
				if (signal?.aborted) parts.push("Command aborted.");
				else parts.push(`Command timed out after ${timeoutMs}ms and was killed.`);
				return resolve({ content: [{ type: "text", text: parts.join("\n") }], isError: true });
			}
			if (code !== 0) parts.push(`[exit code: ${code}]`);
			resolve({ content: [{ type: "text", text: parts.join("\n") }], isError: code !== 0 });
		});
	});
}

// 工具结果进历史、进下一次请求，输出必须小。
function truncate(output: string): string {
	return output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n[output truncated]" : output;
}

// 工具表是异构的（read 收 { path }，bash 收 { command }），注册表位置只能 any（同 tool.ts）。
export function createDefaultTools(): ToolDef<any>[] {
	return [createReadTool(), createEditTool(), createBashTool()];
}

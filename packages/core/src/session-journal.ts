import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	readdir,
} from "node:fs/promises";
import { join } from "node:path";
import {
	SESSION_VERSION,
} from "./session-types.ts";
import type {
	SessionEntry,
	SessionEntryBase,
	SessionEntryData,
	SessionHeader,
} from "./session-types.ts";

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid session JSON record");
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Invalid session ${field}`);
	return value;
}

function parseHeader(value: unknown): SessionHeader {
	const source = record(value);
	if (source.type !== "session") throw new Error("Invalid session header");
	if (source.version !== SESSION_VERSION)
		throw new Error(`Unsupported session version: ${String(source.version)}`);
	return {
		type: "session",
		version: SESSION_VERSION,
		id: string(source.id, "id"),
		createdAt: string(source.createdAt, "createdAt"),
	};
}

const ENTRY_TYPES = new Set([
	"message",
	"submission",
	"tool_intent",
	"tool_update",
	"tool_outcome",
	"run_end",
	"compaction",
]);

const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);

// compaction 字段校验：append 与 open 共用。summary 为空等于悄悄丢历史，必须拒绝。
function parseCompaction(source: Record<string, unknown>): void {
	if (!COMPACTION_REASONS.has(source.reason as string))
		throw new Error(`Invalid compaction reason: ${String(source.reason)}`);
	string(source.summary, "compaction summary");
	string(source.firstKeptEntryId, "compaction firstKeptEntryId");
	const tokens = source.tokensBefore;
	if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)
		throw new Error("Invalid compaction tokensBefore");
}

// firstKept 必须是 parent 祖先链上的 submission 或非 toolResult 的 message entry——
// 切点落在 toolResult 或恢复元数据中间会拆散 toolCall/toolResult 对（计划 Review Focus 1）。
function assertCompactionBoundary(
	byId: Map<string, SessionEntry>,
	parentId: string | null,
	firstKeptEntryId: string,
): void {
	const target = byId.get(firstKeptEntryId);
	if (!target)
		throw new Error(`Invalid compaction boundary: ${firstKeptEntryId}`);
	const conversation = target.type === "submission" ||
		(target.type === "message" && target.message.role !== "toolResult");
	if (!conversation)
		throw new Error(
			`Compaction boundary is not a conversation entry: ${firstKeptEntryId}`,
		);
	for (let current = parentId; current !== null;) {
		if (current === firstKeptEntryId) return;
		current = byId.get(current)?.parentId ?? null;
	}
	throw new Error(`Compaction boundary is not an ancestor: ${firstKeptEntryId}`);
}

function parseEntry(value: unknown): SessionEntry {
	const source = record(value);
	const type = string(source.type, "entry type");
	if (!ENTRY_TYPES.has(type)) throw new Error(`Invalid session entry type: ${type}`);
	const id = string(source.id, "entry id");
	const createdAt = string(source.createdAt, "entry createdAt");
	const parentId = source.parentId === null
		? null
		: string(source.parentId, "entry parentId");
	if (type === "compaction") parseCompaction(source);
	return { ...source, type, id, parentId, createdAt } as SessionEntry;
}

async function durableWrite(
	path: string,
	flag: "a" | "wx",
	source: string,
): Promise<void> {
	const handle = await open(path, flag);
	try {
		await handle.writeFile(source, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class SessionJournal {
	readonly header: SessionHeader;
	readonly path: string;
	readonly entries: SessionEntry[];
	private currentLeafId: string | null;
	private appendTail = Promise.resolve();

	private constructor(
		path: string,
		header: SessionHeader,
		entries: SessionEntry[],
	) {
		this.path = path;
		this.header = header;
		this.entries = entries;
		this.currentLeafId = entries.at(-1)?.id ?? null;
	}

	static async create(directory: string): Promise<SessionJournal> {
		await mkdir(directory, { recursive: true });
		const id = randomUUID();
		const header: SessionHeader = {
			type: "session",
			version: SESSION_VERSION,
			id,
			createdAt: new Date().toISOString(),
		};
		const path = join(directory, `${Date.now()}_${id}.jsonl`);
		await durableWrite(path, "wx", `${JSON.stringify(header)}\n`);
		return new SessionJournal(path, header, []);
	}

	static async open(path: string): Promise<SessionJournal> {
		const source = await readFile(path, "utf8");
		const hasFinalNewline = source.endsWith("\n");
		const lines = source.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (lines.length === 0) throw new Error("Session file is empty");

		let headerValue: unknown;
		try {
			headerValue = JSON.parse(lines[0]!);
		} catch {
			throw new Error("Invalid session header JSON");
		}
		const header = parseHeader(headerValue);
		const entries: SessionEntry[] = [];
		const seen = new Set<string>();
		const byId = new Map<string, SessionEntry>();
		let tornTail = false;
		for (let index = 1; index < lines.length; index++) {
			let value: unknown;
			try {
				value = JSON.parse(lines[index]!);
			} catch {
				if (!hasFinalNewline && index === lines.length - 1) {
					tornTail = true;
					break;
				}
				throw new Error(`Invalid session JSON at line ${index + 1}`);
			}
			const entry = parseEntry(value);
			if (seen.has(entry.id))
				throw new Error(`Duplicate session entry id: ${entry.id}`);
			if (entry.parentId !== null && !seen.has(entry.parentId))
				throw new Error(`Invalid session parent: ${entry.parentId}`);
			if (entry.type === "compaction")
				assertCompactionBoundary(byId, entry.parentId, entry.firstKeptEntryId);
			seen.add(entry.id);
			byId.set(entry.id, entry);
			entries.push(entry);
		}
		if (tornTail) {
			const handle = await open(path, "r+");
			try {
				const prefix = source.slice(0, source.lastIndexOf("\n") + 1);
				await handle.truncate(Buffer.byteLength(prefix, "utf8"));
				await handle.sync();
			} finally {
				await handle.close();
			}
		} else if (!hasFinalNewline) {
			await durableWrite(path, "a", "\n");
		}
		return new SessionJournal(path, header, entries);
	}

	static async findLatest(directory: string): Promise<string> {
		let names: string[];
		try {
			names = (await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => entry.name)
				.sort((left, right) => right.localeCompare(left));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error(`No session found in ${directory}`);
			throw error;
		}
		const latest = names[0];
		if (!latest) throw new Error(`No session found in ${directory}`);
		return join(directory, latest);
	}

	get leafId(): string | null {
		return this.currentLeafId;
	}

	append<TData extends SessionEntryData>(
		data: TData,
	): Promise<SessionEntryBase & TData> {
		const pending = this.appendTail.then(async () => {
			// compaction 先验证再落盘：坏边界不能写进文件，也不能动内存与 leaf。
			if (data.type === "compaction") {
				parseCompaction(data);
				assertCompactionBoundary(
					new Map(this.entries.map((entry) => [entry.id, entry])),
					this.currentLeafId,
					data.firstKeptEntryId,
				);
			}
			const entry = {
				...structuredClone(data),
				id: randomUUID(),
				parentId: this.currentLeafId,
				createdAt: new Date().toISOString(),
			} as SessionEntryBase & TData;
			const line = `${JSON.stringify(entry)}\n`;
			await durableWrite(this.path, "a", line);
			this.entries.push(entry);
			this.currentLeafId = entry.id;
			return entry;
		});
		this.appendTail = pending.then(() => {}, () => {});
		return pending;
	}

	branch(fromId: string): void {
		if (!this.entries.some(({ id }) => id === fromId))
			throw new Error(`Unknown session entry: ${fromId}`);
		this.currentLeafId = fromId;
	}

	pathTo(id: string | null = this.currentLeafId): SessionEntry[] {
		if (id === null) return [];
		const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		const path: SessionEntry[] = [];
		let current: string | null = id;
		while (current !== null) {
			const entry = byId.get(current);
			if (!entry) throw new Error(`Unknown session entry: ${current}`);
			path.push(entry);
			current = entry.parentId;
		}
		return path.reverse();
	}
}

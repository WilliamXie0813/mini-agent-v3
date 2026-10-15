import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SessionJournal,
} from "../src/session-journal.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-session-"));
	directories.push(directory);
	return directory;
}

function header(version = 1) {
	return {
		type: "session",
		version,
		id: "session-1",
		createdAt: "2026-10-15T00:00:00.000Z",
	};
}

function entry(
	id: string,
	parentId: string | null,
	type = "submission",
) {
	return type === "submission"
		? {
				type,
				id,
				parentId,
				createdAt: "2026-10-15T00:00:00.000Z",
				requestId: `request-${id}`,
				prompt: id,
			}
		: {
				type,
				id,
				parentId,
				createdAt: "2026-10-15T00:00:00.000Z",
				submissionId: id,
				status: "completed",
			};
}

async function writeLines(
	path: string,
	lines: unknown[],
	trailingNewline = true,
): Promise<void> {
	const source = lines.map((line) =>
		typeof line === "string" ? line : JSON.stringify(line)
	).join("\n");
	await writeFile(path, `${source}${trailingNewline ? "\n" : ""}`);
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("SessionJournal", () => {
	it("creates a versioned session and appends without rewriting old bytes", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const initial = await readFile(journal.path, "utf8");
		const first = await journal.append({
			type: "submission",
			requestId: "req-1",
			prompt: "hello",
		});
		const afterFirst = await readFile(journal.path, "utf8");
		const second = await journal.append({
			type: "run_end",
			submissionId: first.id,
			status: "completed",
		});
		const afterSecond = await readFile(journal.path, "utf8");

		expect(JSON.parse(initial.trim())).toMatchObject({
			type: "session",
			version: 1,
			id: expect.any(String),
		});
		expect(basename(journal.path)).toMatch(/^\d+_[0-9a-f-]+\.jsonl$/);
		expect(afterFirst.startsWith(initial)).toBe(true);
		expect(afterSecond.startsWith(afterFirst)).toBe(true);
		expect(second.parentId).toBe(first.id);
		expect(
			afterSecond.trimEnd().split("\n").map((line) => JSON.parse(line)),
		).toHaveLength(3);
		expect(await SessionJournal.findLatest(directory)).toBe(journal.path);
	});

	it("branches by parent pointer without touching existing bytes", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const a = await journal.append({
			type: "submission", requestId: "a", prompt: "a",
		});
		const b = await journal.append({
			type: "submission", requestId: "b", prompt: "b",
		});
		const c = await journal.append({
			type: "submission", requestId: "c", prompt: "c",
		});
		const before = await readFile(journal.path, "utf8");

		journal.branch(a.id);

		expect(await readFile(journal.path, "utf8")).toBe(before);
		expect(journal.leafId).toBe(a.id);
		const d = await journal.append({
			type: "submission", requestId: "d", prompt: "d",
		});
		expect(d.parentId).toBe(a.id);
		expect(journal.pathTo(c.id).map(({ id }) => id)).toEqual([
			a.id, b.id, c.id,
		]);
		expect(journal.pathTo(d.id).map(({ id }) => id)).toEqual([a.id, d.id]);
		expect(journal.entries.map(({ id }) => id)).toEqual([
			a.id, b.id, c.id, d.id,
		]);

		const after = await readFile(journal.path, "utf8");
		expect(() => journal.branch("missing")).toThrow(/unknown session entry/i);
		expect(journal.leafId).toBe(d.id);
		expect(await readFile(journal.path, "utf8")).toBe(after);
	});

	it("loads a valid prefix and ignores one torn final fragment", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const first = await journal.append({
			type: "submission", requestId: "one", prompt: "one",
		});
		const second = await journal.append({
			type: "run_end", submissionId: first.id, status: "completed",
		});
		await appendFile(journal.path, '{"type":');

		const reopened = await SessionJournal.open(journal.path);

		expect(reopened.header).toEqual(journal.header);
		expect(reopened.entries).toEqual([first, second]);
		expect(reopened.leafId).toBe(second.id);
	});

	it.each(['{"type":', '{"text":"残缺'])(
		"removes only a torn tail and remains writable across repeated reopen: %s",
		async (fragment) => {
			const directory = await temporaryDirectory();
			const journal = await SessionJournal.create(directory);
			const first = await journal.append({
				type: "submission", requestId: "one", prompt: "完整历史",
			});
			const committed = await readFile(journal.path);
			await appendFile(journal.path, fragment);

			const reopened = await SessionJournal.open(journal.path);
			expect(await readFile(journal.path)).toEqual(committed);
			const second = await reopened.append({
				type: "run_end", submissionId: first.id, status: "completed",
			});
			const again = await SessionJournal.open(journal.path);
			expect(again.entries).toEqual([first, second]);
			expect((await readFile(journal.path)).subarray(0, committed.length))
				.toEqual(committed);
		},
	);

	it("separates a valid unterminated entry before the next append", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "unterminated.jsonl");
		await writeLines(path, [header(), entry("a", null)], false);
		const before = await readFile(path, "utf8");
		const reopened = await SessionJournal.open(path);
		const next = await reopened.append({
			type: "run_end", submissionId: "a", status: "completed",
		});
		expect((await readFile(path, "utf8")).startsWith(`${before}\n`)).toBe(true);
		expect((await SessionJournal.open(path)).entries.map(({ id }) => id))
			.toEqual(["a", next.id]);
	});

	it.each([
		["complete bad final line", [header(), entry("a", null), '{"type":'], true],
		["bad middle line", [header(), '{"type":', entry("a", null)], true],
		["unsupported version", [header(2)], true],
		[
			"duplicate entry id",
			[header(), entry("a", null), entry("a", "a", "run_end")],
			true,
		],
		[
			"missing parent",
			[header(), entry("a", "missing")],
			true,
		],
	] as const)("rejects %s", async (_name, lines, trailingNewline) => {
		const directory = await temporaryDirectory();
		const path = join(directory, "broken.jsonl");
		await writeLines(path, [...lines], trailingNewline);
		await expect(SessionJournal.open(path)).rejects.toThrow(
			/session|json|version|duplicate|parent/i,
		);
	});

	it("serializes concurrent appends into one linear parent chain", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);

		const appended = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				journal.append({
					type: "submission",
					requestId: `request-${index}`,
					prompt: `prompt-${index}`,
				})
			),
		);
		const lines = (await readFile(journal.path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(lines).toHaveLength(21);
		expect(new Set(appended.map(({ id }) => id))).toHaveLength(20);
		expect(appended[0]!.parentId).toBeNull();
		for (let index = 1; index < appended.length; index++) {
			expect(appended[index]!.parentId).toBe(appended[index - 1]!.id);
		}
	});

	it("rejects non-JSON entry data without changing disk or memory", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const before = await readFile(journal.path, "utf8");
		const entriesBefore = journal.entries.slice();

		await expect(journal.append({
			type: "submission",
			requestId: "bad",
			prompt: 1n as unknown as string,
		})).rejects.toThrow();

		expect(await readFile(journal.path, "utf8")).toBe(before);
		expect(journal.entries).toEqual(entriesBefore);
	});

	it("reports an empty directory instead of inventing a session", async () => {
		const directory = await temporaryDirectory();
		await expect(SessionJournal.findLatest(directory)).rejects.toThrow(
			/no session/i,
		);
	});
});

describe("SessionJournal compaction", () => {
	it("appends compaction without rewriting history", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const u1 = await journal.append({
			type: "submission", requestId: "r1", prompt: "one",
		});
		await journal.append({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
		});
		const u2 = await journal.append({
			type: "submission", requestId: "r2", prompt: "two",
		});
		const a2 = await journal.append({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" },
		});
		const before = await readFile(journal.path, "utf8");
		const entriesBefore = journal.entries.slice();

		const compaction = await journal.append({
			type: "compaction",
			reason: "manual",
			summary: "old work summary",
			firstKeptEntryId: u2.id,
			tokensBefore: 120_000,
		});

		const after = await readFile(journal.path, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(journal.entries).toHaveLength(entriesBefore.length + 1);
		expect(journal.entries.slice(0, entriesBefore.length)).toEqual(entriesBefore);
		// compaction 的 parent 是 append 前 leaf；firstKeptEntryId 不改变 tree parent。
		expect(compaction.parentId).toBe(a2.id);
		const reopened = await SessionJournal.open(journal.path);
		expect(reopened.entries.at(-1)).toEqual(compaction);
		expect(u1.parentId).toBeNull();
	});

	it("rejects invalid compaction boundaries without changing disk or memory", async () => {
		const directory = await temporaryDirectory();
		const journal = await SessionJournal.create(directory);
		const u1 = await journal.append({
			type: "submission", requestId: "r1", prompt: "one",
		});
		const a1 = await journal.append({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
		});
		const t1 = await journal.append({
			type: "message",
			message: {
				role: "toolResult", toolCallId: "c1", toolName: "read",
				content: [{ type: "text", text: "result" }], isError: false,
			},
		});
		// 另一条分支：b1 存在但不是 main path（u1→a1→t1）上 leaf 的祖先。
		journal.branch(u1.id);
		const b1 = await journal.append({
			type: "submission", requestId: "r2", prompt: "branch",
		});
		journal.branch(t1.id);

		const before = await readFile(journal.path, "utf8");
		const entriesBefore = journal.entries.slice();
		const leafBefore = journal.leafId;
		const base = {
			type: "compaction" as const,
			reason: "manual" as const,
			summary: "old work summary",
			firstKeptEntryId: a1.id,
			tokensBefore: 120_000,
		};
		const invalid = [
			{ ...base, firstKeptEntryId: "missing-id" },
			{ ...base, firstKeptEntryId: "" },
			{ ...base, firstKeptEntryId: b1.id }, // 存在但不在祖先链
			{ ...base, firstKeptEntryId: t1.id }, // 指向 toolResult
			{ ...base, summary: "" },
			{ ...base, reason: "automatic" as "manual" },
			{ ...base, tokensBefore: -1 },
			{ ...base, tokensBefore: 1.5 },
		];
		for (const data of invalid) {
			await expect(journal.append(data)).rejects.toThrow(
				/compaction|boundary|ancestor|reason|summary|tokensBefore/i,
			);
		}
		expect(await readFile(journal.path, "utf8")).toBe(before);
		expect(journal.entries).toEqual(entriesBefore);
		expect(journal.leafId).toBe(leafBefore);
	});

	it("rejects a handwritten compaction with a bad boundary on reopen", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "bad-compaction.jsonl");
		const toolResultEntry = {
			type: "message",
			id: "t1",
			parentId: "a",
			createdAt: "2026-10-15T00:00:00.000Z",
			message: {
				role: "toolResult", toolCallId: "c1", toolName: "read",
				content: [], isError: false,
			},
		};
		const compaction = {
			type: "compaction",
			id: "c1",
			parentId: "t1",
			createdAt: "2026-10-15T00:00:00.000Z",
			reason: "manual",
			summary: "summary",
			firstKeptEntryId: "t1",
			tokensBefore: 10,
		};
		await writeLines(path, [
			header(),
			entry("a", null),
			toolResultEntry,
			compaction,
		]);
		await expect(SessionJournal.open(path)).rejects.toThrow(
			/compaction|boundary/i,
		);
	});
});

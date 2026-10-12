import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mini-agent-mutations-"));
	await writeFile(join(dir, "a.txt"), "a");
	await writeFile(join(dir, "b.txt"), "b");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("withFileMutationQueue", () => {
	it("serializes operations for the same path", async () => {
		const gate = deferred();
		const firstReached = deferred();
		const order: string[] = [];
		const path = join(dir, "a.txt");
		const first = withFileMutationQueue(path, async () => {
			order.push("first:start");
			firstReached.resolve();
			await gate.promise;
			order.push("first:end");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second:start");
		});

		await firstReached.promise;
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual([
			"first:start",
			"first:end",
			"second:start",
		]);
	});

	it("allows different real files to enter concurrently", async () => {
		const gate = deferred();
		const reachedA = deferred();
		const reachedB = deferred();
		const entered: string[] = [];
		const a = withFileMutationQueue(join(dir, "a.txt"), async () => {
			entered.push("a");
			reachedA.resolve();
			await gate.promise;
		});
		const b = withFileMutationQueue(join(dir, "b.txt"), async () => {
			entered.push("b");
			reachedB.resolve();
			await gate.promise;
		});

		await Promise.all([reachedA.promise, reachedB.promise]);
		expect(entered.sort()).toEqual(["a", "b"]);
		gate.resolve();
		await Promise.all([a, b]);
	});

	it("serializes a symlink alias with its real file", async () => {
		const real = join(dir, "a.txt");
		const alias = join(dir, "alias.txt");
		await symlink(real, alias);
		const gate = deferred();
		const firstReached = deferred();
		const order: string[] = [];
		const first = withFileMutationQueue(real, async () => {
			order.push("real");
			firstReached.resolve();
			await gate.promise;
		});
		const second = withFileMutationQueue(alias, async () => {
			order.push("alias");
		});

		await firstReached.promise;
		await Promise.resolve();
		expect(order).toEqual(["real"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["real", "alias"]);
	});

	it("continues after a previous operation throws", async () => {
		const order: string[] = [];
		const path = join(dir, "a.txt");
		const first = withFileMutationQueue(path, async () => {
			order.push("first");
			throw new Error("write failed");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second");
		});

		await expect(first).rejects.toThrow("write failed");
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("cleans up the queue after all operations settle", async () => {
		const path = join(dir, "a.txt");
		await withFileMutationQueue(path, async () => {});
		let entered = false;

		await withFileMutationQueue(path, async () => {
			entered = true;
		});

		expect(entered).toBe(true);
	});
});

import { realpath } from "node:fs/promises";

const tails = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const key = await realpath(path);
	const previous = tails.get(key) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	tails.set(key, tail);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (tails.get(key) === tail) tails.delete(key);
	}
}

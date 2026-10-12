import { realpath } from "node:fs/promises";

const tails = new Map<string, Promise<void>>();
let registrationTail = Promise.resolve();

export async function withFileMutationQueue<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const waitForRegistration = registrationTail;
	let releaseRegistration = () => {};
	registrationTail = new Promise<void>((resolve) => {
		releaseRegistration = resolve;
	});
	await waitForRegistration;

	let key: string;
	let previous: Promise<void>;
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	let tail: Promise<void>;
	try {
		key = await realpath(path);
		previous = tails.get(key) ?? Promise.resolve();
		tail = previous.then(() => current);
		tails.set(key, tail);
	} finally {
		releaseRegistration();
	}

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (tails.get(key) === tail) tails.delete(key);
	}
}

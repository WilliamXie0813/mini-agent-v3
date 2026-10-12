import { readFile } from "node:fs/promises";

const lockfile = await readFile(
	new URL("../pnpm-lock.yaml", import.meta.url),
	"utf8",
);
const forbidden = [
	"artifactory-corp.",
	"npm.corp.",
];
const match = forbidden.find((value) => lockfile.includes(value));
if (match) {
	throw new Error(`pnpm-lock.yaml contains private registry host "${match}"`);
}

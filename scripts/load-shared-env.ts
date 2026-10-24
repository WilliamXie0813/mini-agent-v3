import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// One shared config is enough for CLI and server. Legacy package-local files
// remain readable during migration, but never override the root .env because
// process.loadEnvFile() preserves values already present in process.env.
export function loadSharedEnv(): void {
	if (process.env.MINI_AGENT_SKIP_ENV_FILE === "1") return;
	const candidates = [
		resolve(repositoryRoot, ".env"),
		resolve(repositoryRoot, "packages/cli/.env"),
		resolve(repositoryRoot, "packages/server/.env"),
	];
	for (const path of candidates) {
		try {
			process.loadEnvFile(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

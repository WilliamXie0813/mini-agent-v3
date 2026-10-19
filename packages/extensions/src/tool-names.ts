import type { ToolDef } from "@mini-agent/core";

export function assertUniqueToolNames(tools: readonly ToolDef<any>[]): void {
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name))
			throw new Error(`duplicate tool name: "${tool.name}"`);
		seen.add(tool.name);
	}
}

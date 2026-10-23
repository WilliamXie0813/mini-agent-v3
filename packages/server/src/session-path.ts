import type { SessionEntry } from "@mini-agent/core";

// journal 的活跃路径 = 从 leaf 沿 parent 链回溯到根的祖先序列；旧分支的 descendants 不在其中。
// entries 是 session 的完整物理顺序记录；leafId 为 null（全新 session）时活跃路径为空。
export function activeSessionPath(
	entries: readonly SessionEntry[],
	leafId: string | null,
): SessionEntry[] {
	if (leafId === null) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	// 坏 snapshot（parent 写环）不能把 transport 线程拖进死循环。
	const seen = new Set<string>();
	let current: string | null = leafId;
	while (current !== null) {
		if (seen.has(current))
			throw new Error(`Session entry parent cycle detected at: ${current}`);
		seen.add(current);
		const entry = byId.get(current);
		if (!entry) throw new Error(`Unknown session entry: ${current}`);
		path.push(entry);
		current = entry.parentId;
	}
	path.reverse();
	// 返回克隆：transport 调用方不得改到 session 的内存对象。
	return structuredClone(path);
}

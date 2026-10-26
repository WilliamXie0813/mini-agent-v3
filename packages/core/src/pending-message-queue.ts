import type { UserMessage } from "@mini-agent/ai";

export type QueueMode = "one-at-a-time" | "all";

interface PendingQueueEntry {
	message: UserMessage;
	mode: QueueMode;
}

export class PendingMessageQueue {
	private entries: PendingQueueEntry[] = [];

	enqueue(message: UserMessage, mode: QueueMode = "one-at-a-time"): void {
		this.entries.push({ message, mode });
	}

	drain(): UserMessage[] {
		const head = this.entries.shift();
		if (!head) {
			return [];
		}
		if (head.mode === "one-at-a-time") {
			return [head.message];
		}
		return [head.message, ...this.entries.splice(0).map((entry) => entry.message)];
	}

	clear(): void {
		this.entries.length = 0;
	}

	get size(): number {
		return this.entries.length;
	}
}

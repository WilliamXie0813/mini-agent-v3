import { getDefaultStreamFn } from "@mini-agent/ai";
import type {
	AssistantMessage,
	Message,
	StreamFn,
} from "@mini-agent/ai";
import { agentLoop } from "./agent-loop.ts";
import type {
	AgentEvent,
	AgentEventListener,
} from "./agent-event.ts";
import {
	createAgentState,
	reduceAgentState,
} from "./agent-state.ts";
import type { AgentState } from "./agent-state.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentOptions {
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

class AgentListenerFailure extends Error {
	readonly original: unknown;

	constructor(original: unknown) {
		super("agent listener failed");
		this.original = original;
	}
}

export class Agent {
	private readonly system: string;
	private readonly streamFn: StreamFn;
	private readonly maxTurns?: number;
	private readonly listeners = new Set<AgentEventListener>();
	private readonly _state: AgentState;
	private activeRun?: ActiveRun;
	private runMessages: Message[] = [];
	private turnOpen = false;
	private messageOpen = false;

	constructor(options: AgentOptions) {
		this.system = options.system;
		this.streamFn = options.streamFn ?? getDefaultStreamFn();
		this.maxTurns = options.maxTurns;
		this._state = createAgentState(
			options.messages ?? [],
			options.tools ?? [],
		);
	}

	get state(): Readonly<AgentState> {
		return this._state;
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(): void {
		this.activeRun?.abortController.abort();
	}

	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	async prompt(prompt: string): Promise<void> {
		if (this.activeRun)
			throw new Error("Agent is already processing an active run");
		if (prompt.trim() === "") return;

		await this.runWithLifecycle(async (signal) => {
			await agentLoop({
				prompt,
				messages: this._state.messages.slice(),
				system: this.system,
				streamFn: this.streamFn,
				signal,
				tools: this._state.tools.slice(),
				maxTurns: this.maxTurns,
				emit: (event) => this.processEvents(event),
			});
		});
	}

	private async runWithLifecycle(
		executor: (signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		const abortController = new AbortController();
		let resolve = () => {};
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		this.activeRun = { promise, resolve, abortController };
		this.runMessages = [];
		this.turnOpen = false;
		this.messageOpen = false;
		this._state.isStreaming = true;

		try {
			try {
				await executor(abortController.signal);
			} catch (error) {
				if (error instanceof AgentListenerFailure) throw error.original;
				try {
					await this.handleRunFailure(
						error,
						abortController.signal.aborted,
					);
				} catch (fallbackError) {
					if (fallbackError instanceof AgentListenerFailure)
						throw fallbackError.original;
					throw fallbackError;
				}
			}
		} finally {
			this._state.isStreaming = false;
			this.activeRun.resolve();
			this.activeRun = undefined;
		}
	}

	private async handleRunFailure(
		error: unknown,
		aborted: boolean,
	): Promise<void> {
		if (!this.turnOpen) await this.processEvents({ type: "turn_start" });
		const message: AssistantMessage = {
			role: "assistant",
			content: [{
				type: "text",
				text: aborted
					? ""
					: error instanceof Error
						? error.message
						: String(error),
			}],
			stopReason: aborted ? "aborted" : "error",
		};
		if (!this.messageOpen) {
			await this.processEvents({ type: "message_start", message });
		}
		await this.processEvents({ type: "message_end", message });
		await this.processEvents({
			type: "turn_end",
			message,
			toolResults: [],
		});
		await this.processEvents({
			type: "agent_end",
			messages: this.runMessages.slice(),
		});
	}

	private async processEvents(event: AgentEvent): Promise<void> {
		reduceAgentState(this._state, event);
		switch (event.type) {
			case "turn_start":
				this.turnOpen = true;
				break;
			case "turn_end":
				this.turnOpen = false;
				break;
			case "message_start":
				this.messageOpen = true;
				break;
			case "message_end":
				this.messageOpen = false;
				this.runMessages.push(event.message);
				break;
			case "agent_end":
				this.turnOpen = false;
				this.messageOpen = false;
				break;
		}
		for (const listener of this.listeners) {
			try {
				await listener(event);
			} catch (error) {
				throw new AgentListenerFailure(error);
			}
		}
	}
}

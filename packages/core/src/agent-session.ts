import { join } from "node:path";
import { getDefaultStreamFn } from "@mini-agent/ai";
import {
	getCurrentTools,
	getToolStateChanges,
} from "@mini-agent/ai";
import type {
	Message,
	StreamFn,
	SystemMessage,
	SystemSection,
} from "@mini-agent/ai";
import { Agent } from "./agent.ts";
import type { AgentOptions } from "./agent-options.ts";
import type {
	AgentEvent,
	AgentEventListener,
} from "./agent-event.ts";
import type { AgentState } from "./agent-state.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	generateCompactionSummary,
	prepareCompaction,
} from "./compaction.ts";
import { SessionJournal } from "./session-journal.ts";
import { recoverInterruptedTools } from "./session-recovery.ts";
import {
	messagesFromSessionPath,
	projectSessionContext,
} from "./session-context.ts";
import type {
	CompactionReason,
	SessionEntry,
	SessionEntryOf,
} from "./session-types.ts";
import { toToolDeclarations } from "./tool.ts";
import type {
	CommitToolIntentContext,
	ToolDef,
	ToolResult,
} from "./tool.ts";

export type AgentSessionOptions = Omit<
	AgentOptions,
	"messages" | "commitToolIntent"
> & {
	directory?: string;
};

export type OpenAgentSessionOptions = AgentSessionOptions & {
	path: string;
};

export class AgentSession {
	private readonly journal: SessionJournal;
	private readonly options: AgentSessionOptions;
	// 普通 Agent 请求与 summarization 共用同一份引用——摘要路径不悄悄换 provider。
	private readonly streamFn: StreamFn;
	private agent: Agent;
	private readonly listeners = new Set<AgentEventListener>();
	private readonly submissions = new Map<
		string,
		SessionEntryOf<"submission">
	>();
	private readonly inFlight = new Map<
		string,
		Promise<SessionEntryOf<"submission">>
	>();
	private readonly intents = new Map<
		string,
		SessionEntryOf<"tool_intent">
	>();
	private activeSubmission?: SessionEntryOf<"submission">;
	private currentAssistantEntryId?: string;
	private operation?: Promise<void>;

	private constructor(
		journal: SessionJournal,
		options: AgentSessionOptions,
		messages: Message[] = [],
	) {
		this.journal = journal;
		this.streamFn = options.streamFn ?? getDefaultStreamFn();
		this.options = {
			...options,
			streamFn: this.streamFn,
			tools: options.tools?.slice(),
		};
		this.agent = this.createAgent(messages);
		for (const entry of journal.entries) {
			if (entry.type === "submission")
				this.submissions.set(entry.requestId, entry);
		}
	}

	static async create(options: AgentSessionOptions): Promise<AgentSession> {
		const directory = options.directory ??
			join(process.cwd(), ".mini-agent", "sessions");
		const journal = await SessionJournal.create(directory);
		const session = new AgentSession(journal, options);
		for (const message of session.agent.state.messages) {
			if (message.role === "system")
				await journal.append({ type: "message", message });
		}
		return session;
	}

	static async open(
		options: OpenAgentSessionOptions,
	): Promise<AgentSession> {
		const { path, ...agentOptions } = options;
		const journal = await SessionJournal.open(path);
		await recoverInterruptedTools(journal, agentOptions.tools ?? []);
		return new AgentSession(
			journal,
			agentOptions,
			messagesFromSessionPath(journal.pathTo()),
		);
	}

	static async openLatest(
		options: AgentSessionOptions,
	): Promise<AgentSession> {
		const directory = options.directory ??
			join(process.cwd(), ".mini-agent", "sessions");
		const path = await SessionJournal.findLatest(directory);
		return AgentSession.open({ ...options, directory, path });
	}

	get sessionId(): string {
		return this.journal.header.id;
	}

	get filePath(): string {
		return this.journal.path;
	}

	get leafId(): string | null {
		return this.journal.leafId;
	}

	get entries(): readonly SessionEntry[] {
		return this.journal.entries;
	}

	get state(): Readonly<AgentState> {
		return this.agent.state;
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	branch(fromId: string): void {
		this.assertIdle("branch");
		this.journal.branch(fromId);
		this.agent = this.createAgent(
			messagesFromSessionPath(this.journal.pathTo()),
		);
	}

	submit(input: {
		requestId: string;
		prompt: string;
	}): Promise<SessionEntryOf<"submission">> {
		if (input.requestId.trim() === "")
			return Promise.reject(new Error("requestId must not be empty"));
		if (input.prompt.trim() === "")
			return Promise.reject(new Error("prompt must not be empty"));
		const existing = this.submissions.get(input.requestId);
		const pending = this.inFlight.get(input.requestId);
		if (pending) return pending;
		if (existing) return Promise.resolve(existing);
		const running = this.runSubmission(input);
		this.inFlight.set(input.requestId, running);
		running.finally(() => {
			if (this.inFlight.get(input.requestId) === running)
				this.inFlight.delete(input.requestId);
		}).catch(() => {});
		return running;
	}

	async appendSystemSections(
		sections: readonly SystemSection[],
	): Promise<void> {
		return this.runExclusive("appendSystemSections", async () => {
			if (sections.length === 0) return;
			const message: SystemMessage = {
				role: "system",
				sections: sections.map((section) => ({ ...section })),
			};
			await this.journal.append({ type: "message", message });
			this.agent.appendSystemSections(message.sections);
		});
	}

	async setTools(tools: ToolDef<any>[]): Promise<void> {
		return this.runExclusive("setTools", async () => {
			const changes = getToolStateChanges(
				getCurrentTools(this.agent.state.messages),
				toToolDeclarations(tools),
			);
			if (
				changes.toolsAdded.length > 0 ||
				changes.toolsRemoved.length > 0
			) {
				const message: SystemMessage = {
					role: "system",
					sections: [],
					...(changes.toolsRemoved.length > 0
						? { toolsRemoved: changes.toolsRemoved }
						: {}),
					...(changes.toolsAdded.length > 0
						? { toolsAdded: changes.toolsAdded }
						: {}),
				};
				await this.journal.append({ type: "message", message });
			}
			this.agent.setTools(tools);
			this.options.tools = tools.slice();
		});
	}

	abort(): void {
		this.agent.abort();
	}

	// 手动压缩只在 idle 时运行（runExclusive 守卫）；成功落盘后立即重建 idle Agent。
	// 无可摘要前缀时返回 undefined：零事件、零 provider 调用、零写入。
	compact(): Promise<SessionEntryOf<"compaction"> | undefined> {
		return this.runExclusive("compact", async () => {
			const entry = await this.compactInternal("manual");
			if (entry) {
				this.agent = this.createAgent(
					messagesFromSessionPath(this.journal.pathTo()),
				);
			}
			return entry;
		});
	}

	// 内部编排：manual / threshold / overflow 三条路径共用。
	// threshold 与 overflow 在 active run 内调用，只 append entry，
	// 由调用方决定何时重建 Agent——这里绝不当场替换 this.agent。
	private async compactInternal(
		reason: CompactionReason,
		signal?: AbortSignal,
	): Promise<SessionEntryOf<"compaction"> | undefined> {
		const projection = projectSessionContext(this.journal.pathTo());
		const preparation = prepareCompaction(
			projection,
			DEFAULT_COMPACTION_SETTINGS.keepRecentTurns,
		);
		if (!preparation) return undefined;
		await this.deliverEvent({
			type: "compaction_start",
			reason,
			contextTokens: preparation.tokensBefore,
		});
		try {
			const summary = await generateCompactionSummary(
				this.streamFn,
				preparation.messagesToSummarize,
				signal,
			);
			const entry = await this.journal.append({
				type: "compaction",
				reason,
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			});
			await this.deliverEvent({
				type: "compaction_end",
				reason,
				status: "completed",
				entryId: entry.id,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			});
			return entry;
		} catch (error) {
			await this.deliverEvent({
				type: "compaction_end",
				reason,
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	waitForIdle(): Promise<void> {
		return this.operation ?? this.agent.waitForIdle();
	}

	private createAgent(messages: Message[]): Agent {
		const agent = new Agent({
			...this.options,
			messages,
			commitToolIntent: (context) => this.commitToolIntent(context),
		});
		agent.subscribe((event) => this.deliverEvent(event));
		return agent;
	}

	private async runSubmission(input: {
		requestId: string;
		prompt: string;
	}): Promise<SessionEntryOf<"submission">> {
		return this.runExclusive("submit", async () => {
			await recoverInterruptedTools(this.journal, this.options.tools ?? []);
			this.agent = this.createAgent(messagesFromSessionPath(this.journal.pathTo()));
			const submission = await this.journal.append({
				type: "submission",
				requestId: input.requestId,
				prompt: input.prompt,
			});
			this.submissions.set(input.requestId, submission);
			this.activeSubmission = submission;
			try {
				await this.agent.prompt(input.prompt);
				return submission;
			} finally {
				this.activeSubmission = undefined;
				this.currentAssistantEntryId = undefined;
				this.intents.clear();
			}
		});
	}

	private async commitToolIntent(
		context: CommitToolIntentContext,
	): Promise<void> {
		if (!this.activeSubmission)
			throw new Error("Cannot commit tool intent without an active submission");
		if (!this.currentAssistantEntryId)
			throw new Error("Cannot commit tool intent before the assistant message");
		const tool = toToolDeclarations([context.tool])[0]!;
		const intent = await this.journal.append({
			type: "tool_intent",
			submissionId: this.activeSubmission.id,
			assistantEntryId: this.currentAssistantEntryId,
			toolCallId: context.toolCall.id,
			tool,
			args: structuredClone(context.args),
			replay: context.tool.replay ?? "unsafe",
			sourceIndex: context.sourceIndex,
		});
		this.intents.set(context.toolCall.id, intent);
	}

	private async deliverEvent(event: AgentEvent): Promise<void> {
		await this.persistEvent(event);
		for (const listener of this.listeners) await listener(event);
	}

	private async persistEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") {
			if (event.message.role === "user") return;
			const intentId = event.message.role === "toolResult"
				? this.intents.get(event.message.toolCallId)?.id
				: undefined;
			const entry = await this.journal.append({
				type: "message",
				message: event.message,
				...(intentId ? { intentId } : {}),
			});
			if (event.message.role === "assistant")
				this.currentAssistantEntryId = entry.id;
			return;
		}
		if (event.type === "tool_execution_update") {
			const intent = this.intents.get(event.toolCallId);
			if (!intent) return;
			await this.journal.append({
				type: "tool_update",
				intentId: intent.id,
				partialResult: event.partialResult as ToolResult,
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			const intent = this.intents.get(event.toolCallId);
			if (!intent) return;
			await this.journal.append({
				type: "tool_outcome",
				intentId: intent.id,
				result: event.result as ToolResult,
				isError: event.isError,
				durationMs: event.durationMs,
			});
			return;
		}
		if (event.type === "turn_end") {
			this.currentAssistantEntryId = undefined;
			this.intents.clear();
			return;
		}
		if (event.type === "agent_end" && this.activeSubmission) {
			const terminal = event.messages.findLast(
				(message) => message.role === "assistant",
			);
			const status = terminal?.role === "assistant" &&
				terminal.stopReason === "error"
				? "error"
				: terminal?.role === "assistant" &&
						terminal.stopReason === "aborted"
					? "aborted"
					: "completed";
			await this.journal.append({
				type: "run_end",
				submissionId: this.activeSubmission.id,
				status,
			});
		}
	}

	private assertIdle(operation: string): void {
		if (this.operation || this.agent.state.isStreaming)
			throw new Error(`Cannot ${operation} while the agent has an active run`);
	}

	private async runExclusive<T>(
		name: string,
		execute: () => Promise<T>,
	): Promise<T> {
		this.assertIdle(name);
		let resolve = () => {};
		this.operation = new Promise<void>((done) => { resolve = done; });
		try {
			return await execute();
		} finally {
			this.operation = undefined;
			resolve();
		}
	}
}

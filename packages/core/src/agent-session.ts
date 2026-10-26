import { join } from "node:path";
import { getDefaultStreamFn } from "@mini-agent/ai";
import {
	getCurrentTools,
	getToolStateChanges,
} from "@mini-agent/ai";
import type {
	AssistantMessage,
	Message,
	StreamContext,
	StreamFn,
	SystemMessage,
	SystemSection,
} from "@mini-agent/ai";
import { Agent } from "./agent.ts";
import type { AgentOptions, PrepareRequestContext, SessionHooks } from "./agent-options.ts";
import type {
	AgentEvent,
	AgentEventListener,
} from "./agent-event.ts";
import type { QueueMode } from "./pending-message-queue.ts";
import type { AgentState } from "./agent-state.ts";
import {
	estimateContextTokens,
	generateCompactionSummary,
	normalizeCompactionOptions,
	prepareCompaction,
	shouldCompact,
} from "./compaction.ts";
import type { CompactionSettings } from "./compaction.ts";
import { SessionJournal } from "./session-journal.ts";
import { recoverInterruptedTools } from "./session-recovery.ts";
import {
	messagesFromSessionPath,
	projectSessionContext,
	streamContextFromSessionPath,
} from "./session-context.ts";
import type {
	CompactionReason,
	SessionEntry,
	SessionEntryOf,
} from "./session-types.ts";
import { toToolDeclarations } from "./tool.ts";
import type {
	CommitToolIntentContext,
	ToolCall,
	ToolDef,
	ToolResult,
} from "./tool.ts";

export type AgentSessionOptions = Omit<
	AgentOptions,
	// 编排所有权：这八个 hook（含 session 内部的 journal 重投影/阈值压缩两个 seam）
	// 只能经 hooks 注入——调用方直接传入会绕过 journal 编排，这里全部 Omit 掉。
	// prepareRequest 的合并在 createAgent()：session 内部版本先跑，扩展装饰其后。
	| "messages"
	| "commitToolIntent"
	| "prepareRequest"
	| "recoverContextOverflow"
	| "beforeToolCall"
	| "afterToolCall"
	| "transformContext"
	| "finishTurn"
	| "prepareNextTurnWithContext"
> & {
	directory?: string;
	contextWindow?: number;
	compaction?: Partial<CompactionSettings>;
	// 扩展系统的全部接入面（阶段 11）：六个 hook 字段打包在此。
	hooks?: SessionHooks;
};

export type OpenAgentSessionOptions = AgentSessionOptions & {
	path: string;
};

export class AgentSession {
	private readonly journal: SessionJournal;
	private readonly options: AgentSessionOptions;
	// 普通 Agent 请求与 summarization 共用同一份引用——摘要路径不悄悄换 provider。
	private readonly streamFn: StreamFn;
	private readonly contextWindow: number;
	private readonly compactionSettings: CompactionSettings;
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
	private skipNextSubmissionUser = false;
	private currentAssistantEntryId?: string;
	private operation?: Promise<void>;
	// threshold/overflow 压缩发生在 active run 内，不能当场替换 this.agent；
	// 标记后由 runSubmission 在旧 Agent 完全 settle 后重建。
	private compactionPendingRebuild = false;

	private constructor(
		journal: SessionJournal,
		options: AgentSessionOptions,
		messages: Message[] = [],
	) {
		this.journal = journal;
		this.streamFn = options.streamFn ?? getDefaultStreamFn();
		const compaction = normalizeCompactionOptions(
			options.contextWindow,
			options.compaction,
		);
		this.contextWindow = compaction.contextWindow;
		this.compactionSettings = compaction.settings;
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

	steer(prompt: string, mode: QueueMode = "one-at-a-time"): void {
		this.agent.steer(prompt, mode);
	}

	followUp(prompt: string, mode: QueueMode = "one-at-a-time"): void {
		this.agent.followUp(prompt, mode);
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
				this.compactionPendingRebuild = false;
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
			this.compactionSettings.keepRecentTurns,
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
			this.compactionPendingRebuild = true;
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
		const hooks = this.options.hooks ?? {};
		const agent = new Agent({
			...this.options,
			messages,
			commitToolIntent: (context) => this.commitToolIntent(context),
			// 编排所有权规则：session 内部的 prepareRequest（journal 重投影 +
			// 阈值压缩）先跑，hooks 里的扩展 prepareRequest 只拿到定稿请求、
			// 在其后做最后一道装饰——扩展版本绝不覆盖 session 的版本。
			prepareRequest: async (input) => {
				const finalized = await this.prepareRequest(input);
				return hooks.prepareRequest
					? hooks.prepareRequest({
							context: finalized,
							signal: input.signal,
						})
					: finalized;
			},
			recoverContextOverflow: (input) =>
				this.recoverContextOverflow(input.signal),
			// 其余五个决策 hook 原样透传，未注册时保持 undefined（与阶段 10 一致）。
			beforeToolCall: hooks.beforeToolCall,
			afterToolCall: hooks.afterToolCall,
			transformContext: hooks.transformContext,
			finishTurn: hooks.finishTurn,
			prepareNextTurnWithContext: hooks.prepareNextTurnWithContext,
		});
		agent.subscribe((event) => this.deliverEvent(event));
		return agent;
	}

	// overflow 路径：provider 报结构化超窗后压缩一次并让 loop 重试。
	// enabled:false 不阻止这条路径（它只关 threshold 自动压缩）。
	// 只有成功 append entry 才返回 true；无 eligible prefix 返回 false，不重试。
	// signal 必须透传：恢复摘要发生在 active run 内，abort 要能打断它。
	private async recoverContextOverflow(signal?: AbortSignal): Promise<boolean> {
		return (await this.compactInternal("overflow", signal)) !== undefined;
	}

	// 阈值路径：忽略传入的 raw conversation，从 journal 重新投影——
	// run 内 threshold 压缩后，后续 turn 立刻看到压缩结果与最新历史。
	// enabled:false 只关这条自动路径；手动 compact() 与 overflow 恢复不受影响。
	private async prepareRequest(
		input: PrepareRequestContext,
	): Promise<StreamContext> {
		const path = this.journal.pathTo();
		const tokens = estimateContextTokens(projectSessionContext(path));
		if (
			shouldCompact(tokens, this.contextWindow, this.compactionSettings)
		) {
			await this.compactInternal("threshold", input.signal);
			// 无 eligible prefix 时 compaction 是 no-op，返回未压缩 context，不循环。
			return streamContextFromSessionPath(this.journal.pathTo());
		}
		return streamContextFromSessionPath(path);
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
				this.skipNextSubmissionUser = true;
				await this.agent.prompt(input.prompt);
				return submission;
			} finally {
				this.skipNextSubmissionUser = false;
				// run 内压缩只 append entry；旧 Agent 的 state 仍是压缩前 transcript，
				// settle 后从 durable projection 重建，下一次操作看到压缩后的上下文。
				if (this.compactionPendingRebuild) {
					this.compactionPendingRebuild = false;
					this.agent = this.createAgent(
						messagesFromSessionPath(this.journal.pathTo()),
					);
				}
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

	// 为没有 intent 的已了结调用（blocked / 校验失败 / 中止）补 journal 事实。
	// 工具未注册（找不到 ToolDef）时无法构造 intent 条目，保持阶段 5 行为不动。
	private async commitUnexecutedToolIntent(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): Promise<SessionEntryOf<"tool_intent"> | undefined> {
		const tool = this.options.tools?.find(({ name }) => name === event.toolName);
		if (!tool || !this.activeSubmission || !this.currentAssistantEntryId)
			return undefined;
		const assistant = this.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const block = assistant?.content.find(
			(content): content is ToolCall =>
				content.type === "toolCall" && content.id === event.toolCallId,
		);
		const intent = await this.journal.append({
			type: "tool_intent",
			submissionId: this.activeSubmission.id,
			assistantEntryId: this.currentAssistantEntryId,
			toolCallId: event.toolCallId,
			tool: toToolDeclarations([tool])[0]!,
			args: structuredClone(block?.arguments ?? {}),
			replay: tool.replay ?? "unsafe",
			sourceIndex: assistant
				? assistant.content.findIndex(
						(content) => content.type === "toolCall" && content.id === event.toolCallId,
					)
				: -1,
		});
		this.intents.set(event.toolCallId, intent);
		return intent;
	}

	private async deliverEvent(event: AgentEvent): Promise<void> {
		await this.persistEvent(event);
		for (const listener of this.listeners) await listener(event);
	}

	private async persistEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") {
			if (event.message.role === "user" && this.skipNextSubmissionUser) {
				this.skipNextSubmissionUser = false;
				return;
			}
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
			let intent = this.intents.get(event.toolCallId);
			// 执行层只在真正越过 execute 边界前提交 intent（阶段 5 语义）。
			// 被权限规则 block / 校验失败 / 中止的已知工具调用没有 intent。
			// 仅当会话经 hooks 接入了扩展系统时才补 intent + tool_outcome：
			// 不传 hooks 必须与阶段 10 逐字节一致（这类调用什么都不记），
			// 有 hooks 时 journal 不留死角，中断恢复也不会重放已了结的调用。
			if (!intent && this.options.hooks)
				intent = await this.commitUnexecutedToolIntent(event);
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

import { getDefaultStreamFn } from "@mini-agent/ai";
import type { AssistantMessage, Message, StreamFn, SystemSection } from "@mini-agent/ai";
import { agentLoop } from "./agent-loop.ts";
import { AgentInfrastructureFailure } from "./agent-infrastructure-failure.ts";
export { AgentInfrastructureFailure } from "./agent-infrastructure-failure.ts";
import type { AgentOptions } from "./agent-options.ts";
import type { AfterToolCall, PrepareRequest, RecoverContextOverflow, TransformContext } from "./agent-options.ts";
import type { AgentEvent, AgentEventListener } from "./agent-event.ts";
import { appendSystemSections, createAgentState, reduceAgentState, replaceAgentTools } from "./agent-state.ts";
import type { AgentState } from "./agent-state.ts";
import type {
	BeforeToolCall,
	CommitToolIntent,
	ToolDef,
	ToolExecutionMode,
} from "./tool.ts";

type ActiveRun = {
	promise: Promise<void>; resolve: () => void; abortController: AbortController;
};

export class Agent {
	private readonly streamFn: StreamFn;
	private readonly maxTurns?: number;
	private readonly commitToolIntent?: CommitToolIntent;
	// 只由构造配置与 AgentSession 编排持有，不成为通用扩展 hook（阶段 11 再说）。
	private readonly recoverContextOverflow?: RecoverContextOverflow;
	private readonly listeners = new Set<AgentEventListener>();
	private readonly _state: AgentState;
	public beforeToolCall?: BeforeToolCall;
	public afterToolCall?: AfterToolCall;
	// 与 beforeToolCall 同为可替换 seam（阶段 10 的阈值压缩由 AgentSession 挂在这里）。
	public prepareRequest?: PrepareRequest;
	public transformContext?: TransformContext;
	public toolExecution: ToolExecutionMode;
	private activeRun?: ActiveRun;
	private runMessages: Message[] = [];
	private turnOpen = false;
	private messageOpen = false;
	private eventTail = Promise.resolve();

	constructor(options: AgentOptions) {
		this.streamFn = options.streamFn ?? getDefaultStreamFn();
		this.maxTurns = options.maxTurns;
		const commitToolIntent = options.commitToolIntent;
		this.commitToolIntent = commitToolIntent
			? async (context) => {
				try {
					await commitToolIntent(context);
				} catch (error) {
					throw new AgentInfrastructureFailure(error);
				}
			}
			: undefined;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareRequest = options.prepareRequest;
		this.transformContext = options.transformContext;
		this.recoverContextOverflow = options.recoverContextOverflow;
		this.toolExecution = options.toolExecution ?? "parallel";
		this._state = createAgentState(
			options.messages ?? [],
			options.tools ?? [],
			options.system,
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

	// 运行中禁止改 prompt/工具：单次 run 的 provider snapshot、执行表和历史不能中途分叉。
	appendSystemSections(sections: readonly SystemSection[]): void {
		this.assertIdle("appendSystemSections");
		appendSystemSections(this._state, sections);
	}

	setTools(tools: ToolDef<any>[]): void {
		this.assertIdle("setTools");
		replaceAgentTools(this._state, tools);
	}

	private assertIdle(operation: string): void {
		if (this.activeRun)
			throw new Error(`Cannot ${operation} while the agent has an active run`);
	}

	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	async prompt(prompt: string): Promise<void> {
		if (this.activeRun)
			throw new Error("Agent is already processing an active run");
		if (prompt.trim() === "") return;

		await this.runWithLifecycle(async (signal) => {
			// hook failure 与 listener failure 同为基础设施失败：原样冒泡，不合成 error 消息。
			const prepareRequest = this.prepareRequest;
			const transformContext = this.transformContext;
			const recoverContextOverflow = this.recoverContextOverflow;
			const afterToolCall = this.afterToolCall;
			await agentLoop({
				prompt,
				messages: this._state.messages.slice(),
				streamFn: this.streamFn,
				signal,
				tools: this._state.tools.slice(),
				maxTurns: this.maxTurns,
				beforeToolCall: this.beforeToolCall,
				afterToolCall: afterToolCall
					? async (context, hookSignal) => {
						try {
							return await afterToolCall(context, hookSignal);
						} catch (error) {
							throw new AgentInfrastructureFailure(error);
						}
					}
					: undefined,
				toolExecution: this.toolExecution,
				commitToolIntent: this.commitToolIntent,
				prepareRequest: prepareRequest
					? async (input) => {
						try {
							return await prepareRequest(input);
						} catch (error) {
							throw new AgentInfrastructureFailure(error);
						}
					}
					: undefined,
				transformContext: transformContext
					? async (messages, signal) => {
						try {
							return await transformContext(messages, signal);
						} catch (error) {
							throw new AgentInfrastructureFailure(error);
						}
					}
					: undefined,
				recoverContextOverflow: recoverContextOverflow
					? async (input) => {
						try {
							return await recoverContextOverflow(input);
						} catch (error) {
							throw new AgentInfrastructureFailure(error);
						}
					}
					: undefined,
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
				if (error instanceof AgentInfrastructureFailure) throw error.original;
				try {
					await this.handleRunFailure(
						error,
						abortController.signal.aborted,
					);
				} catch (fallbackError) {
					if (fallbackError instanceof AgentInfrastructureFailure)
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

	private processEvents(event: AgentEvent): Promise<void> {
		const delivery = this.eventTail.then(() => this.deliverEvent(event));
		delivery.catch(() => {});
		this.eventTail = delivery.then(() => {}, () => {});
		return delivery;
	}

	private async deliverEvent(event: AgentEvent): Promise<void> {
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
				this.activeRun?.abortController.abort();
				throw new AgentInfrastructureFailure(error);
			}
		}
	}
}

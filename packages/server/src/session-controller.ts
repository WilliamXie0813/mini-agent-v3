import { randomUUID } from "node:crypto";
import type { StopReason } from "@mini-agent/ai";
import type { Agent, AgentEvent } from "@mini-agent/core";
import {
	PROTOCOL_VERSION,
	V1_CAPABILITIES,
} from "@mini-agent/protocol";
import type { ClientCommand, RunOutcome, ServerMessage } from "@mini-agent/protocol";
import type { DemoScenarioRegistry } from "./scenarios.ts";

export type ServerMessageSink = (
	message: ServerMessage,
) => void | Promise<void>;

export interface SessionControllerOptions {
	send: ServerMessageSink;
	scenarios: DemoScenarioRegistry;
	createRunId?: () => string;
	now?: () => number;
}

type ActiveRun = {
	runId: string;
	agent: Agent;
	startedAt: number;
	sequence: number;
	lastStopReason?: StopReason;
	promise?: Promise<void>;
};

export class SessionController {
	private readonly sendFn: ServerMessageSink;
	private readonly scenarios: DemoScenarioRegistry;
	private readonly createRunId: () => string;
	private readonly now: () => number;
	private activeRun?: ActiveRun;
	private closed = false;

	constructor(options: SessionControllerOptions) {
		this.sendFn = options.send;
		this.scenarios = options.scenarios;
		this.createRunId = options.createRunId ?? randomUUID;
		this.now = options.now ?? (() => performance.now());
	}

	async sendReady(): Promise<void> {
		await this.send({
			type: "server.ready",
			protocolVersion: PROTOCOL_VERSION,
			capabilities: [...V1_CAPABILITIES],
			scenarios: this.scenarios.list(),
		});
	}

	async handle(command: ClientCommand): Promise<void> {
		if (this.closed) return;
		switch (command.type) {
			case "run.start":
				await this.startRun(command);
				break;
			case "run.abort":
				await this.abortRun(command.requestId);
				break;
			case "workspace.reset":
				await this.reset(command.requestId);
				break;
		}
	}

	disconnect(): void {
		this.closed = true;
		this.activeRun?.agent.abort();
		this.activeRun = undefined;
	}

	private async startRun(
		command: Extract<ClientCommand, { type: "run.start" }>,
	): Promise<void> {
		if (this.activeRun) {
			await this.sendError(command.requestId, "RUN_ACTIVE", "A run is already active.");
			return;
		}
		if (command.prompt.trim() === "") {
			await this.sendError(command.requestId, "EMPTY_PROMPT", "Prompt must not be blank.");
			return;
		}
		const agent = this.scenarios.createAgent(command.scenarioId);
		if (!agent) {
			await this.sendError(
				command.requestId,
				"SCENARIO_NOT_FOUND",
				`Unknown demo scenario "${command.scenarioId}".`,
			);
			return;
		}

		const run: ActiveRun = {
			runId: this.createRunId(),
			agent,
			startedAt: this.now(),
			sequence: 0,
		};
		this.activeRun = run;
		try {
			await this.send({
				type: "run.accepted",
				requestId: command.requestId,
				runId: run.runId,
			});
		} catch (error) {
			this.activeRun = undefined;
			throw error;
		}

		agent.subscribe((event) => this.deliverEvent(run, event));
		run.promise = this.runAgent(run, command.prompt);
		run.promise.catch(() => {});
	}

	private async runAgent(run: ActiveRun, prompt: string): Promise<void> {
		let outcome: RunOutcome;
		try {
			await run.agent.prompt(prompt);
			outcome = this.outcomeFor(run.lastStopReason);
		} catch {
			outcome = "failed";
		}

		try {
			await this.send({ type: "run.settled", runId: run.runId, outcome });
		} catch {
			if (outcome !== "failed") {
				try {
					await this.send({
						type: "run.settled",
						runId: run.runId,
						outcome: "failed",
					});
				} catch {}
			}
		} finally {
			if (this.activeRun === run) this.activeRun = undefined;
		}
	}

	private async deliverEvent(run: ActiveRun, event: AgentEvent): Promise<void> {
		if (
			event.type === "message_end" &&
			event.message.role === "assistant"
		) {
			run.lastStopReason = event.message.stopReason;
		}
		await this.send({
			type: "agent.event",
			runId: run.runId,
			sequence: run.sequence++,
			elapsedMs: Math.max(0, this.now() - run.startedAt),
			event,
		});
	}

	private async abortRun(requestId: string): Promise<void> {
		if (!this.activeRun) {
			await this.sendError(
				requestId,
				"NO_ACTIVE_RUN",
				"No active run to abort.",
			);
			return;
		}
		this.activeRun.agent.abort();
	}

	private async reset(requestId: string): Promise<void> {
		if (this.activeRun) {
			await this.sendError(requestId, "RUN_ACTIVE", "A run is already active.");
			return;
		}
		await this.send({ type: "workspace.reset", requestId });
	}

	private outcomeFor(stopReason: StopReason | undefined): RunOutcome {
		if (stopReason === "aborted") return "aborted";
		if (stopReason === "error") return "error";
		return "completed";
	}
	private async sendError(
		requestId: string,
		code: string,
		message: string,
	): Promise<void> {
		await this.send({ type: "protocol.error", requestId, code, message });
	}
	private async send(message: ServerMessage): Promise<void> {
		if (this.closed) return;
		await this.sendFn(message);
	}
}

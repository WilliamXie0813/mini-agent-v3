import { describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
} from "@mini-agent/ai";
import type { StreamFn } from "@mini-agent/ai";
import { Agent } from "@mini-agent/core";
import {
	PROTOCOL_VERSION,
	V1_CAPABILITIES,
} from "@mini-agent/protocol";
import type { ServerMessage } from "@mini-agent/protocol";
import { createDemoScenarioRegistry } from "../src/scenarios.ts";
import type { DemoScenarioRegistry } from "../src/scenarios.ts";
import { SessionController } from "../src/session-controller.ts";

type Predicate = (message: ServerMessage) => boolean;

function recorder(
	rejectOnce?: Predicate,
): {
	messages: ServerMessage[];
	send: (message: ServerMessage) => Promise<void>;
	waitFor: (predicate: Predicate) => Promise<ServerMessage>;
} {
	const messages: ServerMessage[] = [];
	const waiters = new Set<{
		predicate: Predicate;
		resolve: (message: ServerMessage) => void;
	}>();
	let rejected = false;
	return {
		messages,
		send: async (message) => {
			if (!rejected && rejectOnce?.(message)) {
				rejected = true;
				throw new Error("socket send failed");
			}
			messages.push(message);
			for (const waiter of waiters) {
				if (!waiter.predicate(message)) continue;
				waiters.delete(waiter);
				waiter.resolve(message);
			}
		},
		waitFor: (predicate) => {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const waiter = { predicate, resolve };
				waiters.add(waiter);
				setTimeout(() => {
					if (!waiters.delete(waiter)) return;
					reject(new Error("timed out waiting for server message"));
				}, 2_000);
			});
		},
	};
}

function createController(
	send: (message: ServerMessage) => void | Promise<void>,
	scenarios: DemoScenarioRegistry = createDemoScenarioRegistry(),
): SessionController {
	let now = 0;
	return new SessionController({
		send,
		scenarios,
		createRunId: () => "run-1",
		now: () => {
			now += 5;
			return now;
		},
	});
}

function terminal(outcome: string): Predicate {
	return (message) =>
		message.type === "run.settled" && message.outcome === outcome;
}

function errorRegistry(): DemoScenarioRegistry {
	const streamFn: StreamFn = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.end());
		return stream;
	};
	return {
		list: () => [{
			id: "error",
			title: "Error",
			description: "End without done.",
		}],
		createAgent: (id) =>
			id === "error"
				? new Agent({ system: "test", streamFn })
				: undefined,
	};
}

describe("SessionController", () => {
	it("sends protocol metadata and scenario summaries", async () => {
		const sink = recorder();
		const scenarios = createDemoScenarioRegistry();
		const controller = createController(sink.send, scenarios);

		await controller.sendReady();

		expect(sink.messages).toEqual([{
			type: "server.ready",
			protocolVersion: PROTOCOL_VERSION,
			capabilities: [...V1_CAPABILITIES],
			scenarios: scenarios.list(),
		}]);
	});

	it("accepts before events and emits monotonic envelopes", async () => {
		const sink = recorder();
		const controller = createController(sink.send);

		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "streaming-text",
			prompt: "show the stream",
		});
		await sink.waitFor(terminal("completed"));

		expect(sink.messages[0]).toEqual({
			type: "run.accepted",
			requestId: "request-1",
			runId: "run-1",
		});
		const events = sink.messages.filter(
			(message) => message.type === "agent.event",
		);
		expect(events.map(({ sequence }) => sequence)).toEqual(
			events.map((_event, index) => index),
		);
		expect(events.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
		expect(events.map(({ elapsedMs }) => elapsedMs)).toEqual(
			[...events.map(({ elapsedMs }) => elapsedMs)].sort((a, b) => a - b),
		);
	});

	it("rejects semantic start errors without creating a run", async () => {
		const sink = recorder();
		const controller = createController(sink.send);

		await controller.handle({
			type: "run.start",
			requestId: "blank",
			scenarioId: "streaming-text",
			prompt: "  ",
		});
		await controller.handle({
			type: "run.start",
			requestId: "missing",
			scenarioId: "missing",
			prompt: "hello",
		});

		expect(sink.messages.map((message) =>
			message.type === "protocol.error" ? message.code : message.type,
		)).toEqual(["EMPTY_PROMPT", "SCENARIO_NOT_FOUND"]);
	});

	it("rejects concurrent start and reset while a run is active", async () => {
		const sink = recorder();
		const controller = createController(sink.send);
		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "abort-lifecycle",
			prompt: "keep running",
		});
		await sink.waitFor((message) =>
			message.type === "agent.event" &&
			message.event.type === "message_update",
		);

		await controller.handle({
			type: "run.start",
			requestId: "request-2",
			scenarioId: "streaming-text",
			prompt: "second",
		});
		await controller.handle({
			type: "workspace.reset",
			requestId: "request-3",
		});
		await controller.handle({ type: "run.abort", requestId: "stop" });
		await sink.waitFor(terminal("aborted"));

		const errors = sink.messages.filter(
			(message) => message.type === "protocol.error",
		);
		expect(errors.map(({ code }) => code)).toEqual(["RUN_ACTIVE", "RUN_ACTIVE"]);
	});

	it("acknowledges reset while idle", async () => {
		const sink = recorder();
		const controller = createController(sink.send);

		await controller.handle({
			type: "workspace.reset",
			requestId: "reset-1",
		});

		expect(sink.messages).toEqual([{
			type: "workspace.reset",
			requestId: "reset-1",
		}]);
	});

	it("maps a lifecycle error separately from infrastructure failure", async () => {
		const sink = recorder();
		const controller = createController(sink.send, errorRegistry());

		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "error",
			prompt: "fail visibly",
		});
		await sink.waitFor(terminal("error"));

		expect(
			sink.messages.some(
				(message) =>
					message.type === "agent.event" &&
					message.event.type === "agent_end",
			),
		).toBe(true);
	});

	it("settles failed when an event listener rejects without inventing agent_end", async () => {
		const sink = recorder(
			(message) =>
				message.type === "agent.event" &&
				message.event.type === "message_update",
		);
		const controller = createController(sink.send);

		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "streaming-text",
			prompt: "break delivery",
		});
		await sink.waitFor(terminal("failed"));

		expect(
			sink.messages.some(
				(message) =>
					message.type === "agent.event" &&
					message.event.type === "agent_end",
			),
		).toBe(false);
	});

	it("reports abort without an active run", async () => {
		const sink = recorder();
		const controller = createController(sink.send);

		await controller.handle({ type: "run.abort", requestId: "stop" });

		expect(sink.messages).toEqual([{
			type: "protocol.error",
			requestId: "stop",
			code: "NO_ACTIVE_RUN",
			message: "No active run to abort.",
		}]);
	});

	it("waits for the real aborted lifecycle before settling", async () => {
		const sink = recorder();
		const controller = createController(sink.send);
		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "abort-lifecycle",
			prompt: "stop later",
		});
		await sink.waitFor((message) =>
			message.type === "agent.event" &&
			message.event.type === "message_update",
		);

		await controller.handle({ type: "run.abort", requestId: "stop" });
		await sink.waitFor(terminal("aborted"));

		const endIndex = sink.messages.findIndex(
			(message) =>
				message.type === "agent.event" &&
				message.event.type === "agent_end",
		);
		const settledIndex = sink.messages.findIndex(terminal("aborted"));
		expect(endIndex).toBeGreaterThan(-1);
		expect(settledIndex).toBeGreaterThan(endIndex);
	});

	it("aborts and suppresses old run output after disconnect", async () => {
		const sink = recorder();
		const base = createDemoScenarioRegistry();
		let created: Agent | undefined;
		const trackingRegistry: DemoScenarioRegistry = {
			list: () => base.list(),
			createAgent: (id) => {
				created = base.createAgent(id);
				return created;
			},
		};
		const controller = createController(sink.send, trackingRegistry);
		await controller.handle({
			type: "run.start",
			requestId: "request-1",
			scenarioId: "abort-lifecycle",
			prompt: "disconnect later",
		});
		await sink.waitFor((message) =>
			message.type === "agent.event" &&
			message.event.type === "message_update",
		);
		const countAtDisconnect = sink.messages.length;

		controller.disconnect();
		await created?.waitForIdle();

		expect(sink.messages).toHaveLength(countAtDisconnect);
		expect(sink.messages.some((message) => message.type === "run.settled"))
			.toBe(false);
	});
});

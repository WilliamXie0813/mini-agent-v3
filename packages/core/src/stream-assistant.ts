import { consumeAssistantMessage } from "@mini-agent/ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
} from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";

export async function streamAssistantMessage(
	stream: AssistantMessageEventStream,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	return consumeAssistantMessage(stream, async (event) => {
		switch (event.type) {
			case "start":
				await emit({
					type: "message_start",
					message: { ...event.partial },
				});
				break;
			case "text_delta":
				await emit({
					type: "message_update",
					message: { ...event.partial },
					assistantMessageEvent: event,
				});
				break;
			case "done":
				await emit({ type: "message_end", message: event.message });
				break;
		}
	});
}

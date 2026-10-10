export type * from "./types.ts";
export { setDefaultStreamFn, getDefaultStreamFn, consumeAssistantMessage } from "./stream-fn.ts";
export type { StreamFn, StreamDeltaHandler } from "./stream-fn.ts";
export { createFakeStreamFn } from "./fake.ts";
export { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from "./event-stream.ts";

import { Agent } from "@mini-agent/core";
import { createFakeStreamFn } from "@mini-agent/ai";
import { bootstrapExtensions } from "@mini-agent/extensions";

const boot = await bootstrapExtensions({
	extensions: [{
		name: "cart",
		factory(api) {
			api.registerTool({
				name: "lint_cart",
				description: "Memory-only coupon teaching check",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: async () => ({
					content: [{ type: "text", text: "coupon checked" }],
				}),
			});
			api.on("tool_call", ({ toolCall }) => {
				if (toolCall.name === "bash") {
					return { block: true, reason: "cart: bash disabled" };
				}
				return undefined;
			});
		},
	}],
});
const agent = new Agent({
	system: "You are a coupon teaching agent.",
	tools: boot.tools([]),
	...boot.hooks,
	streamFn: createFakeStreamFn([
		[{ type: "toolCall", id: "check-1", name: "lint_cart", arguments: {} }],
		"优惠券检查示例完成",
	]),
});
agent.subscribe((event) => boot.notify(event));
await agent.prompt("给 src/cart.ts 加优惠券折扣，然后检查");
console.log(agent.state.messages);

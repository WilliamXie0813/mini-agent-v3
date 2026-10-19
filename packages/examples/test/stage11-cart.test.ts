import { readFile } from "node:fs/promises";
import type { Message } from "@mini-agent/ai";
import { describe, expect, it, vi } from "vitest";

// The stage 11 teaching page embeds this file verbatim in its <pre id="runnable-example">
// block (docs/stages/11-extension-system-explained.html). Keeping both copies identical,
// rather than letting the doc drift from the real script, is what this test guards.
describe("stage 11 cart example", () => {
	it("matches the code embedded in the stage 11 teaching page", async () => {
		const html = await readFile(new URL(
			"../../../docs/stages/11-extension-system-explained.html", import.meta.url,
		), "utf8");
		const match = /<pre id="runnable-example">([\s\S]*?)<\/pre>/.exec(html);
		expect(match, "The teaching page must still embed the runnable example").not.toBeNull();
		const documented = match![1]!
			.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
		const source = await readFile(new URL("../src/stage11-cart.ts", import.meta.url), "utf8");
		expect(source).toBe(documented);
	});

	it("runs the documented example, blocking bash and checking the coupon tool", async () => {
		const logs: unknown[][] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args); });
		try {
			// A fresh module instance each run would need a dynamic cache-bust; this file
			// is only imported here, so the module's top-level await runs exactly once.
			await import("../src/stage11-cart.ts");
		} finally {
			spy.mockRestore();
		}
		expect(logs).toHaveLength(1);
		const messages = logs[0]![0] as Message[];
		expect(messages.find((m) => m.role === "toolResult")).toMatchObject({
			toolName: "lint_cart", isError: false,
			content: [{ type: "text", text: "coupon checked" }],
		});
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});

import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
	textContent = ""; innerHTML = ""; disabled = false; className = "";
	children: Element[] = [];
	private clickHandler?: () => void;
	classList = { toggle: (_name: string, _enabled: boolean) => {} };
	addEventListener(type: string, handler: () => void) { if (type === "click") this.clickHandler = handler; }
	append(child: Element) { this.children.push(child); }
	click() { if (!this.disabled) this.clickHandler?.(); }
}

async function page() {
	const html = await readFile(new URL("../../../docs/stages/07-anthropic-sse-explained.html", import.meta.url), "utf8");
	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
	const get = (id: string) => {
		const value = elements.get(id);
		if (!value) throw new Error(`missing element ${id}`);
		return value;
	};
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (!script) throw new Error("missing teaching script");
	let tick: (() => void) | undefined;
	runInNewContext(script, {
		document: { getElementById: get, createElement: () => new Element() },
		TextEncoder, TextDecoder,
		window: { matchMedia: () => ({ matches: false }) },
		setInterval: (fn: () => void) => { tick = fn; return 1; },
		clearInterval: () => { tick = undefined; },
	});
	return { get, tick: () => tick?.() };
}

describe("stage 7 teaching interactions", () => {
	it("plays one source-consistent story and resets without advancing behind the user", async () => {
		const { get, tick } = await page();
		expect(get("story-event").textContent).toContain("prompt");
		get("next").click();
		expect(get("story-event").textContent).toContain("toAnthropicRequest");
		get("play").click();
		tick();
		expect(get("story-event").textContent).toContain("fetch");
		get("reset").click();
		tick();
		expect(get("story-event").textContent).toContain("prompt");
		for (let i = 0; i < 20; i++) get("next").click();
		expect(get("story-event").textContent).toContain("agent_end");
		expect(get("next").disabled).toBe(true);
		get("debug-steps").children[6].click();
		expect(get("debug-title").textContent).toContain("message_stop");
	});

	it("shows a split UTF-8 character surviving the streaming decoder", async () => {
		const { get } = await page();
		for (let i = 0; i < 20; i++) get("bytes-next").click();
		expect(get("bytes-decoded").textContent).toContain("你好");
		expect(get("bytes-naive").textContent).toContain("�");
		expect(get("bytes-frames").textContent).toContain('{"text":"你好"}');
		get("bytes-reset").click();
		expect(get("bytes-frames").textContent).toContain("尚无完整帧");
	});

	it("distinguishes length feedback from error/abort in the terminal lab", async () => {
		const { get } = await page();
		get("case-length").click();
		expect(get("case-result").textContent).toContain("done(length)");
		expect(get("case-execute").textContent).toContain("0");
		expect(get("case-history").textContent).toContain("toolResult");
		get("case-eof").click();
		expect(get("case-result").textContent).toContain("error(error)");
		expect(get("case-history").textContent).not.toContain("toolResult");
		get("case-abort").click();
		expect(get("case-result").textContent).toContain("aborted");
		get("case-success").click();
		expect(get("case-execute").textContent).toContain("2");
	});
});

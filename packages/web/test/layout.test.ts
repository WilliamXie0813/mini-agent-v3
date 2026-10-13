import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = await readFile(resolve(process.cwd(), "src/styles.css"), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	if (start === -1) return "";
	const bodyStart = css.indexOf("{", start) + 1;
	const end = css.indexOf("}", bodyStart);
	return css.slice(bodyStart, end).replace(/\s+/g, " ").trim();
}

describe("workspace scroll containment", () => {
	it("locks the document and workspace to the viewport", () => {
		expect(rule("html, body, #root")).toContain("height: 100%");
		expect(rule("html, body, #root")).toContain("overflow: hidden");
		expect(rule(".workspace")).toContain("height: 100vh");
		expect(rule(".workspace")).toContain("overflow: hidden");
		expect(rule(".workspace")).toContain("flex-direction: column");
	});

	it("lets the grid and columns shrink instead of growing the page", () => {
		expect(rule(".workspace-grid")).toContain("flex: 1");
		expect(rule(".workspace-grid")).toContain("min-height: 0");
		expect(rule(".workspace-grid")).toContain("overflow: hidden");
		expect(rule(".conversation-column")).toContain("min-height: 0");
		expect(rule(".conversation-column")).toContain("overflow: hidden");
		expect(rule(".inspector-column")).toContain("min-height: 0");
		expect(rule(".inspector-column")).toContain("overflow: hidden");
	});

	it("keeps the composer fixed while chat owns vertical scrolling", () => {
		expect(rule(".chat-panel")).toContain("overflow: auto");
		expect(rule(".prompt-composer")).toContain("flex: 0 0 auto");
		expect(rule(".prompt-composer textarea")).toContain("resize: none");
	});

	it("gives the JSON inspector a larger responsive detail track", () => {
		expect(rule(".inspector-column")).toContain(
			"grid-template-rows: auto minmax(0, 1fr) clamp(300px, 45%, 480px)",
		);
	});
});

import { useState } from "react";
import type { TimelineItem } from "../state/types.ts";

export function EventDetails({
	item,
}: {
	item?: TimelineItem;
}): React.JSX.Element {
	const [copyError, setCopyError] = useState<string>();
	if (!item) {
		return (
			<section className="event-details">
				<div className="empty-state">Select a Timeline item to inspect it.</div>
			</section>
		);
	}
	const envelopes = item.kind === "turn"
		? [item.start, ...(item.end ? [item.end] : [])]
		: item.envelopes;
	const first = envelopes[0];
	const json = JSON.stringify(
		envelopes.length === 1 ? first : envelopes,
		null,
		2,
	);
	async function copy(): Promise<void> {
		setCopyError(undefined);
		try {
			await navigator.clipboard.writeText(json);
		} catch (error) {
			setCopyError(error instanceof Error ? error.message : String(error));
		}
	}
	return (
		<section className="event-details">
			<div className="event-details-heading">
				<strong>Selected event</strong>
				<button className="text-button" onClick={() => void copy()}>
					Copy JSON
				</button>
			</div>
			<div className="event-meta">
				<span>Run {first.runId}</span>
				<span>Sequence {first.sequence}</span>
				<span>Elapsed {first.elapsedMs}ms</span>
			</div>
			{copyError && <div role="alert">Copy failed: {copyError}</div>}
			<pre>{json}</pre>
		</section>
	);
}

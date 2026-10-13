import { useState } from "react";
import { JsonViewer } from "json-edit-react";
import type { TimelineItem } from "../state/types.ts";

export function EventDetails({
	item,
}: {
	item?: TimelineItem;
}): React.JSX.Element {
	const [copyError, setCopyError] = useState<string>();
	const [searchText, setSearchText] = useState("");
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
	const data = envelopes.length === 1 ? first : envelopes;
	const json = JSON.stringify(data, null, 2);
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
			<label className="json-search">
				<span className="sr-only">Search JSON</span>
				<input
					type="search"
					aria-label="Search JSON"
					value={searchText}
					placeholder="Search keys and values..."
					onChange={(event) => setSearchText(event.target.value)}
				/>
			</label>
			<div className="json-viewer" data-testid="json-viewer">
				<JsonViewer
					data={data}
					searchText={searchText || undefined}
					searchFilter="all"
				/>
			</div>
		</section>
	);
}

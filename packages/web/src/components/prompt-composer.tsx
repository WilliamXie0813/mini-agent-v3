export interface PromptComposerProps {
	prompt: string;
	scenarioTitle?: string;
	disabled: boolean;
	onPromptChange(prompt: string): void;
	onRun(): void;
}

export function PromptComposer({
	prompt,
	scenarioTitle,
	disabled,
	onPromptChange,
	onRun,
}: PromptComposerProps): React.JSX.Element {
	return (
		<div className="prompt-composer">
			<label>
				<span className="sr-only">Prompt</span>
				<textarea
					aria-label="Prompt"
					value={prompt}
					disabled={disabled}
					placeholder="Enter the user message for this demo run..."
					onChange={(event) => onPromptChange(event.target.value)}
				/>
			</label>
			<div className="composer-footer">
				<span className="demo-chip">
					Demo: {scenarioTitle ?? "None selected"}
				</span>
				<span className="composer-note">new run clears current data</span>
				<button
					className="primary-button"
					disabled={disabled || prompt.trim() === "" || !scenarioTitle}
					onClick={onRun}
				>
					Run
				</button>
			</div>
		</div>
	);
}

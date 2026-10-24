import { useState } from "react";
import type { ChangeEvent, FormEvent, JSX } from "react";

export interface PromptComposerProps {
	prompt: string;
	disabled: boolean;
	note: string;
	onPromptChange(prompt: string): void;
	onSubmit(): void;
}

// Composer 固定在中央面板底部；running / compacting / 未连接时禁用。
// Web 与 CLI 共享 core，但各自进程持有自己的 session——这里只发 prompt.submit。
export function PromptComposer(props: PromptComposerProps): JSX.Element {
	const { prompt, disabled, note, onPromptChange, onSubmit } = props;
	const [validationError, setValidationError] = useState<string>();
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (disabled) return;
		if (prompt.trim().length === 0) {
			setValidationError("Enter a prompt before sending.");
			return;
		}
		setValidationError(undefined);
		onSubmit();
	};
	const change = (event: ChangeEvent<HTMLTextAreaElement>) => {
		setValidationError(undefined);
		onPromptChange(event.target.value);
	};
	return (
		<form className="prompt-composer" onSubmit={submit} noValidate>
			<label htmlFor="prompt-input">Prompt</label>
			<div className="prompt-row">
				<textarea
					id="prompt-input"
					rows={3}
					value={prompt}
					disabled={disabled}
					onChange={change}
					placeholder="Ask the agent…"
					aria-invalid={validationError !== undefined}
					aria-describedby="composer-status"
				/>
				<button type="submit" disabled={disabled}>
					Send
				</button>
			</div>
			<p
				id="composer-status"
				className={validationError ? "composer-note composer-error" : "composer-note"}
				role={validationError ? "alert" : "status"}
				aria-live="polite"
			>
				{validationError ?? note}
			</p>
		</form>
	);
}

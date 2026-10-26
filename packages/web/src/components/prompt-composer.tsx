import { useState } from "react";
import type { ChangeEvent, FormEvent, JSX, KeyboardEvent } from "react";

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
	const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key !== "Enter" ||
			(!event.metaKey && !event.ctrlKey) ||
			event.nativeEvent.isComposing
		) {
			return;
		}
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	};
	return (
		<form className="prompt-composer" onSubmit={submit} noValidate>
			<div className="prompt-composer-inner">
				<div className="composer-heading">
					<label htmlFor="prompt-input">Prompt</label>
					<span className="composer-shortcut" aria-hidden="true">
						<kbd>Ctrl/⌘</kbd>
						<span>+</span>
						<kbd>Enter</kbd>
					</span>
				</div>
				<div className="prompt-editor">
					<textarea
						id="prompt-input"
						rows={2}
						value={prompt}
						disabled={disabled}
						onChange={change}
						onKeyDown={keyDown}
						placeholder="Ask the agent…"
						aria-invalid={validationError !== undefined}
						aria-describedby="composer-status"
					/>
					<div className="composer-footer">
						<p
							id="composer-status"
							className={
								validationError ? "composer-note composer-error" : "composer-note"
							}
							role={validationError ? "alert" : "status"}
							aria-live="polite"
						>
							{validationError ?? note}
						</p>
						<button type="submit" disabled={disabled}>
							<span>Send</span>
							<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
								<path
									d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</button>
					</div>
				</div>
			</div>
		</form>
	);
}

import type { ChangeEvent, FormEvent, JSX } from "react";

export interface PromptComposerProps {
	prompt: string;
	disabled: boolean;
	onPromptChange(prompt: string): void;
	onSubmit(): void;
}

// Composer 固定在中央面板底部；running / compacting / 未连接时禁用。
// Web 与 CLI 共享 core，但各自进程持有自己的 session——这里只发 prompt.submit。
export function PromptComposer(props: PromptComposerProps): JSX.Element {
	const { prompt, disabled, onPromptChange, onSubmit } = props;
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!disabled) onSubmit();
	};
	const change = (event: ChangeEvent<HTMLTextAreaElement>) =>
		onPromptChange(event.target.value);
	return (
		<form className="prompt-composer" onSubmit={submit}>
			<label htmlFor="prompt-input">Prompt</label>
			<div className="prompt-row">
				<textarea
					id="prompt-input"
					rows={3}
					value={prompt}
					disabled={disabled}
					onChange={change}
					placeholder="Ask the agent…"
				/>
				<button type="submit" disabled={disabled}>
					Send
				</button>
			</div>
			<p className="composer-note">
				Web and CLI share the same core; each process holds its own session.
			</p>
		</form>
	);
}

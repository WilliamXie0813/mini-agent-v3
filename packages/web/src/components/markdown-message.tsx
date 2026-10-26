import { Children, isValidElement } from "react";
import type { JSX, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function MarkdownPre({ children }: { children?: ReactNode }): JSX.Element {
	const firstChild = Children.toArray(children)[0];
	const className = isValidElement<{ className?: string }>(firstChild)
		? firstChild.props.className
		: undefined;
	const language = className
		?.split(/\s+/)
		.find((part) => part.startsWith("language-"))
		?.slice("language-".length);

	return (
		<div className="chat-code-block">
			<span className="chat-code-language">{language || "code"}</span>
			<pre tabIndex={0}>{children}</pre>
		</div>
	);
}

const components: Components = {
	a({ node: _node, ...props }) {
		return <a {...props} target="_blank" rel="noreferrer noopener" />;
	},
	pre({ node: _node, children }) {
		return <MarkdownPre>{children}</MarkdownPre>;
	},
	table({ node: _node, children, ...props }) {
		return (
			<div
				className="chat-table-scroll"
				role="group"
				aria-label="Markdown table"
				tabIndex={0}
			>
				<table {...props}>{children}</table>
			</div>
		);
	},
};

export function MarkdownMessage({ text }: { text: string }): JSX.Element {
	return (
		<div className="chat-text chat-markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

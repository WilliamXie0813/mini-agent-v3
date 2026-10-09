import type { AssistantMessageEvent, StreamContext } from "./types.ts";

// 依赖注入缝：core 完全不知道 provider 存在（spec §3.2a）。
// 用函数类型而非 interface Provider——只有一个方法时，接口会带来
// 实现类、构造、注册表这一串仪式；函数可以内联写。
export type StreamFn = (
	context: StreamContext,
	signal?: AbortSignal,
) => AsyncGenerator<AssistantMessageEvent>;

let defaultStreamFn: StreamFn | undefined;

// 供组装方（cli）安装默认实现；传 undefined 即清除。
export function setDefaultStreamFn(fn: StreamFn | undefined): void {
	defaultStreamFn = fn;
}

export function getDefaultStreamFn(): StreamFn {
	if (defaultStreamFn === undefined) {
		throw new Error("no default stream fn installed; call setDefaultStreamFn() at composition root");
	}
	return defaultStreamFn;
}

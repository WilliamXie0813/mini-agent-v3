// hook / listener / 循环校验失败的基础设施失败包装：agent.ts 解包后把原错误
// 原样冒泡给调用方，不合成 error 消息。独立成模块是为了让 agent.ts 与
// agent-loop.ts 同向引用，避免运行时循环导入。
export class AgentInfrastructureFailure extends Error {
	readonly original: unknown;
	constructor(original: unknown) {
		super("agent infrastructure failed"); this.original = original;
	}
}

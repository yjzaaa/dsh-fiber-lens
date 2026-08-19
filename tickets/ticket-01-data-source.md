# Decision Ticket 1: 活动状态的数据来源

## Question

dsh-fiber-lens 要显示 fiber 的"活动状态"（谁在干活），数据来源是什么？

### 背景
当前 `dsh-fiber-lens` 只读取 `fiber.state`（lifecycle: pending/loading/active/failed/disposed），这只能知道插件"活着"，不能知道"正在干活"。

参考 `dsh-agent-teams` 通过 `ctx.subagents.listChildren()` 和 `ctx.agents.get(id).status` 获取明确的 working/idle 状态。

### 选项分析

**A. 监听 `session/event`**
- 优点：已有事件系统，不侵入核心
- 缺点：事件是异步的，有延迟；不是所有操作都有事件

**B. Hook agent-loop 的 `agent/status` 事件**
- 优点：agent-loop 已有 `status`（idle/running）和 `agent/status` 事件
- 缺点：只覆盖 agent-loop，不覆盖其他插件（如 tool、webserver）

**C. 拦截 tool 层调用**
- 优点：能知道具体哪个 tool 在执行
- 缺点：需要修改 tool 注册机制，可能侵入式

**D. 组合方案**
- `agent/status` + `session/event` + 自定义事件
- 优点：覆盖全面
- 缺点：复杂度高

### 需要验证

1. `session/event` 事件的具体格式和频率
2. `agent/status` 事件是否包含 agentId/fiber 关联信息
3. 系统插件（如 webserver）是否有类似的状态事件

## 建议下一步

Research：读取 DSH 核心代码，验证上述事件系统的可用性。

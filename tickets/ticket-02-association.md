# Decision Ticket 2: Fiber ↔ Session ↔ Agent 关联机制

## Question

global 视角下，如何将 fiber 实例与 session/agent 关联起来？

### 背景
`dsh-fiber-lens` 是全局视角，但"谁在干活"是 per-session 的概念。需要建立：
```
Fiber (技术原语) → Session (用户会话) → Agent (业务概念)
```

### 选项分析

**A. 通过 fiber.parent 链推断**
- 沿 parent 链向上找 agent-loop fiber
- 优点：不依赖额外数据
- 缺点：脆弱，依赖内部结构

**B. 通过 Session 事件中的上下文**
- `session/event` 事件是否携带 fiber 信息？
- 优点：准确
- 缺点：需要事件系统支持

**C. 通过 fiber 的私有属性**
- Cordis fiber 是否有 `sessionId` 或 `agentId` 属性？
- 优点：直接
- 缺点：可能不存在或不稳定

**D. 反向索引：从 Session 找 Fiber**
- Session 是否持有其 fiber 的引用？
- 优点：准确
- 缺点：需要 Session 暴露 API

### 需要验证

1. Cordis Fiber 的结构（是否有 session/agent 关联字段）
2. Session 实例是否可访问其 fiber 树
3. agent-loop 是否暴露其与 session 的关联

## 建议下一步

Research：读取 Cordis 和 DSH 核心代码，验证关联机制。

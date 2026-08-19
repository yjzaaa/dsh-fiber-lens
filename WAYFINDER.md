# Wayfinder Map: dsh-fiber-lens 元层级运行时显微镜

## Destination

dsh-fiber-lens 成为 Cordis 运行时的"元层级显微镜"：全局视角下，实时显示 fiber 结构 + 活动状态，区分"活着"（lifecycle）和"正在干活"（activity）。它位于 agent-teams 等应用层级面板之上，提供系统底层的 X 光 + 心电图叠加视图。

## Notes

- **领域**: Cordis 运行时、DSH 插件系统
- **参考设计**: dsh-agent-teams 的活动追踪机制（`snapshot.ts` + `ActivityPanel.tsx`）
- **关键约束**: 零 inject 骨架（被观测系统崩溃时观测者必须活着）
- **技能**: cordis-plugin-development, grilling
- **当前代码**: `D:\projects\dsh-fiber-lens`

## Decisions so far

（暂无）

## Not yet specified

- 具体的事件监听机制（`session/event` 是否足够？）
- 与现有面板的联动 API 设计
- 性能优化策略（大量 fiber 时的渲染）
- 状态持久化（是否需要？）

## Out of scope

- 替代 agent-teams 等应用层级面板
- 修改 Cordis 核心或 agent-loop
- 跨进程追踪（只关注单 DSH 进程）

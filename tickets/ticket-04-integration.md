# Decision Ticket 4: 与上层面板的联动机制

## Question

dsh-fiber-lens（元层级）如何与 agent-teams 等应用层级面板联动？

### 背景
dsh-fiber-lens 位于更高层级，可以看到 agent-teams 的 fibers。用户可能希望：
- 在 fiber-lens 中点击 agent-teams 相关 fiber → 打开/高亮 agent-teams 面板
- 在 agent-teams 中操作 → fiber-lens 实时反映变化

### 选项分析

**A. 事件总线**
- 通过 Cordis Event 系统发送跨插件事件
- 优点：解耦，标准机制
- 缺点：需要双方约定事件格式

**B. Slot 注册**
- fiber-lens 注册一个 slot，其他面板可以查询
- 优点：标准 Cordis 机制
- 缺点：单向（查询），非实时推送

**C. URL/路由联动**
- 通过 URL hash 或 query 参数传递状态
- 优点：简单，可书签
- 缺点：不适合实时同步

**D. 不联动，保持独立**
- fiber-lens 只显示，不交互
- 优点：简单，无依赖
- 缺点：用户体验割裂

### 需要决定

1. 联动的粒度（只点击跳转？还是双向同步？）
2. 联动的时机（实时？还是按需？）
3. 错误处理（目标面板未安装时？）

## 建议下一步

Grilling：与用户讨论联动的具体需求和优先级。

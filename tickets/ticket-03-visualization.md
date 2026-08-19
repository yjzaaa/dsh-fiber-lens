# Decision Ticket 3: 可视化叠加设计

## Question

如何在焦点链画布上叠加"活动状态"，区分"活着"和"正在干活"？

### 背景
当前 `dsh-fiber-lens` 使用 lifecycle state 决定颜色（active=绿, disposed=灰）。需要增加 activity 维度。

### 设计空间

**状态矩阵**（lifecycle × activity）：

| | inactive (heat=0) | warm (heat>0) | inflight |
|---|:---:|:---:|:---:|
| **active** | 淡绿/灰 | 亮绿 | 脉冲发光 |
| **pending** | 淡黄 | 黄 | 脉冲 |
| **loading** | 淡蓝 | 蓝 | 脉冲 |
| **failed** | 红 | 红闪 | 红闪 |
| **disposed** | 灰 | - | - |

**视觉编码选项**：

1. **颜色亮度**：inactive 暗，inflight 亮
2. **动画**：inflight 脉冲，warm 呼吸
3. **边框**：inflight 发光边框
4. **标签**：inflight 显示当前操作（如 "tool:bash"）

### 参考

`dsh-agent-teams` 的设计：
- `working`：浮动动画 + 蓝色高亮
- `idle`：呼吸动画
- `unknown`：思考动画

### 需要决定

1. 动画系统（CSS keyframes vs SMIL vs JS）
2. 状态过渡（平滑过渡 vs 即时切换）
3. 信息密度（是否显示操作标签？）
4. 性能（大量节点时的渲染策略）

## 建议下一步

Prototype：创建一个静态 HTML 原型，测试不同的视觉编码方案。

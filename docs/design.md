# Fiber Lens UI 设计方案

> 版本：v0.2 设计稿（待实现） ｜ 状态：已与需求方确认方向
> 本文档是 dsh-fiber-lens 视觉与交互重设计的唯一权威来源，实现以此为准。

---

## 1. 设计定位

**"一个活的运行时 X 光片"** —— 不是静态列表，而是能看见系统呼吸的观测器。

审美对标：Linear 的克制 + VS Code 调试面板的信息密度 + 暗色科技感（继承 cordis-core 架构图集验证过的视觉语言）。

真实数据特性（设计必须服务于它们）：

- 264 个 fiber 节点，树深通常 5-6 层
- 秒级差量轮询（ping/version + snapshot）
- version 事件流由 Cordis `internal/status` / `internal/plugin` / `internal/service` 驱动

## 2. 视图架构

面板头部提供双视图开关：

| 视图 | 用途 |
|------|------|
| ☰ 树列表 | 紧凑缩进列表，快速扫描 264 个节点、搜索定位异常 |
| ⬡ DAG 画布 | 有向无环图，实时呈现插件状态流转（主视图） |

树列表保留现有实现并做视觉升级；DAG 画布为本方案核心新增。

## 3. 视觉系统

| 元素 | 方案 |
|------|------|
| 主题 | 跟随 DSH 亮/暗主题（`--dsw-*` token + 回退值），暗色为 slate 深蓝 + 玻璃拟态 backdrop-blur |
| 状态色板 | 六色（与 cordis-core 图集一致）：active `#34d399` / pending `#fbbf24` / loading `#22d3ee` / unloading `#fb923c` / failed `#fb7185` / disposed `#64748b` |
| 字体 | JetBrains Mono / ui-monospace；数字 `tabular-nums` 对齐 |
| 状态指示 | CSS 绘制发光圆点（box-shadow 光晕），不用 emoji；状态即色彩 |
| 层级表达 | 缩进 + 左侧 tree guide 引导线，hover 时引导线增亮 |

## 4. DAG 画布设计

### 4.1 数据到图的映射

| 图元素 | 数据来源 | 视觉编码 |
|--------|---------|---------|
| 节点 | `fibers[]` | 圆角矩形，填充=状态色板 |
| 实线边（挂载关系） | `parentUid` + `depth` | slate 细线，构成 DAG 骨架 |
| 虚线边（服务依赖） | `provides` × `inject` join（provider → consumer） | 青色虚线 + dash-flow 流动动画 |
| 节点状态变化 | version 快照 diff | 颜色 morph 400ms + 扩散脉冲环 |
| 流转事件 | 同上 diff 计算 | 右侧事件 ticker 流 |

### 4.2 布局算法：分层整齐树（确定性，不用力导向）

关键决策：**手写 tidy tree 布局，不引入 d3-force 等库**。

- 挂载结构本质是树（每 fiber 恰一个 parent），树是 DAG 的特例
- 算法：叶子按名字排序分配槽位，父节点居中于子节点，层级轴 = depth
- O(n)、确定性、快照更新时只有变化节点移动，图不整体抖动
- 服务依赖边作为覆盖层三次贝塞尔曲线画在骨架上；默认只显示与选中节点相关的虚线，避免"毛线球"

布局方向：**自左向右**（root 在最左，depth 向右展开）。264 节点深度仅 5-6 层，横向比纵向省空间，节点名文本沿水平方向好排。

### 4.3 规模策略

- 默认只展开 depth ≤ 2（约 20-30 个节点）；折叠节点显示 `+N` 角标，点击展开子树
- 滚轮缩放（0.2x–3x，围绕光标）、拖拽平移、双击复位（手写 transform，约 60 行，零依赖）
- 264 个 SVG 节点全量渲染无压力，不做虚拟化

### 4.4 实时流转动画（核心体验）

```
version 递增 → 新旧快照 diff →
  ├─ 状态变化节点：颜色 morph + 扩散脉冲环（如 pending→loading 琥珀转青）
  ├─ 新增节点：从父节点位置 pop-in 飞出
  ├─ 消失节点：红闪脉冲后淡出移除
  └─ 依赖激活：consumer 亮起瞬间，光点沿服务虚线从 provider 流向它
                （stroke-dashoffset 动画，单次 1s，不循环骚扰）
```

### 4.5 事件 ticker

右侧面板内嵌（宽 180px），滚动列出最近 20 条状态流转：

```
AgentLoop    pending → loading   14:32:07
llm-retry    loading → active    14:32:08
```

新事件从顶部滑入；点击事件定位并高亮对应节点。

## 5. 动画系统总览（三层，克制不喧闹）

**面板生命周期**
- 打开：`scale(0.92) + fade + translateY(12px)` 弹簧入场（cubic-bezier(0.22,1,0.36,1)，300ms）
- 关闭：反向 150ms 快速退出
- 列表视图逐行 stagger 入场（每行 15ms，仅首次）

**数据驱动动画**
- 状态变化行/节点：底色脉冲 1.2s（active 绿闪、failed 红闪）
- 新增 fiber：pop-in（scale 0.6→1 + fade）
- 消失 fiber：灰化淡出 400ms 后移除
- version 号递增：标题栏 ⚡ 脉冲 + 底部扫描线扫过一次
- pending 节点：持续呼吸发光

**微交互**
- 行 hover：背景 80ms 渐显 + 引导线增亮
- 统计胶囊 hover 上浮 1px；点击过滤时列表交叉淡入淡出
- 详情卡：grid-template-rows 0fr→1fr 滑梯展开
- 树折叠：子树高度收放动画

## 6. 实现约束

- 全部动画用 CSS transitions/keyframes + SVG SMIL，零 JS 动画库（保持 bundle ~15KB 量级）
- diff 逻辑在 store.patch 内对比新旧快照，给节点打 `changeKind: 'state' | 'new' | 'gone'` 标记，纯客户端计算
- 折叠状态、视图选择存 panel 本地 state，不进快照、不持久化
- 快照字段无需扩展（uid/name/state/depth/parentUid/inject/missing/provides 已够用）

## 7. 交付轮次

| 轮次 | 内容 | 验收点 |
|------|------|--------|
| P1 | DAG 骨架：tidy 布局 + 挂载边 + 状态色节点 + 缩放平移 + 折叠 | 264 节点图可缩放浏览，布局稳定 |
| P2 | 实时动画：diff 驱动状态 morph / pop-in / 脉冲环 + 事件 ticker | 起一个插件能看到 pending→active 流转 |
| P3 | 服务虚线 + 选中依赖高亮 + 光点沿边流动 + 列表视图视觉升级 | 整体视觉统一，双视图切换顺滑 |

## 8. 未决项（实现时按推荐默认落地）

| 项 | 推荐默认 |
|----|---------|
| 布局方向 | 自左向右 |
| 事件 ticker 位置 | 面板右侧内嵌（180px） |
| 服务虚线默认可见性 | 仅选中节点相关 |

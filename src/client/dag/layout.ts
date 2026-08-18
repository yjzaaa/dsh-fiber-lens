/**
 * DAG 布局层（snapshot → diff → layout → render 管线的第三段，纯函数）。
 * 左→右分层 tidy tree：叶子按父内名称排序占据连续 Y 槽位，父节点居中于子节点，
 * 列轴 = 布局深度（从根遍历计数，不直接信 fiber.depth 字段；孤儿/成环兜底为根级）。
 * 每次重排为确定性输出：兄弟序不变则未变更子树坐标不变（无全图抖动）。
 * @module dsh-fiber-lens/client/dag/layout
 */
import type { FiberNode } from '../store.ts'

/** 节点宽（世界坐标 px）。 */
export const NODE_WIDTH = 168
/** 节点高（世界坐标 px）。 */
export const NODE_HEIGHT = 30
/** 相邻列水平间距（不变量 1 的水平净距来源，远大于 8px）。 */
export const COLUMN_GAP = 56
/** 相邻行垂直间距（不变量 1 的垂直净距来源，≥ 8px）。 */
export const ROW_GAP = 14

const MARGIN = 20
/** 不变量 1：相邻节点最小净距。 */
const MIN_CLEARANCE = 8
/** 标签水平内缩：边从节点左右边缘中点进出，内缩后标签盒与入边/出边天然不相交。 */
const LABEL_INSET_X = 10
/** 标签盒的竖直文字带高度（用于不变量 3 的标签压边检测）。 */
const LABEL_BAND_HEIGHT = 14

/** 单个节点的布局结果：世界坐标矩形 + 布局深度 + 源 fiber。 */
export interface LayoutNode {
  x: number
  y: number
  width: number
  height: number
  /** 布局深度（根 = 0，逐层 +1）；可能与 fiber.depth 不同（孤儿兜底）。 */
  depth: number
  fiber: FiberNode
}

/** 挂载边（实线）：端点为世界坐标（父右缘中点 → 子左缘中点）。 */
export interface LayoutEdge {
  fromUid: string
  toUid: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 整图布局结果：render 层的唯一数据源。 */
export interface LayoutResult {
  /** 键为 fiber.uid；uid 为 null 的 fiber 使用匿名键 `#anon:<index>`。 */
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  width: number
  height: number
}

/** 父内排序：先名称后 uid，保证确定性。 */
const byName = (a: FiberNode, b: FiberNode): number =>
  a.name === b.name ? (a.uid ?? '').localeCompare(b.uid ?? '') : a.name.localeCompare(b.name)

/**
 * 构建挂载树邻接表：parentUid → 有序子 fiber 列表。
 * uid 为 null、parentUid 悬空或自指的 fiber 一律归为根级（键 null）。
 * @param fibers 快照 fiber 列表
 * @returns parentUid（null 表示根级）→ 父内按名称排序的子节点列表
 */
export function buildTree(fibers: FiberNode[]): Map<string | null, FiberNode[]> {
  const uids = new Set<string>()
  for (const fiber of fibers) if (fiber.uid !== null) uids.add(fiber.uid)
  const tree = new Map<string | null, FiberNode[]>()
  for (const fiber of fibers) {
    let parent = fiber.parentUid
    if (fiber.uid === null || parent === null || parent === fiber.uid || !uids.has(parent)) parent = null
    const list = tree.get(parent)
    if (list === undefined) tree.set(parent, [fiber])
    else list.push(fiber)
  }
  for (const list of tree.values()) list.sort(byName)
  return tree
}

/**
 * 分层 tidy tree 布局（O(n)，递归后序放置）。
 * @param fibers 快照 fiber 列表
 * @returns 节点矩形 + 挂载边 + 画布包围盒
 */
export function tidyLayout(fibers: FiberNode[]): LayoutResult {
  const tree = buildTree(fibers)
  // uid 为 null 的 fiber 无法作为 Map<string, …> 的键，分配匿名键。
  const keys = new Map<FiberNode, string>()
  fibers.forEach((fiber, index) => keys.set(fiber, fiber.uid ?? `#anon:${index}`))

  const nodes = new Map<string, LayoutNode>()
  const edges: LayoutEdge[] = []
  const visited = new Set<FiberNode>()
  const column = NODE_WIDTH + COLUMN_GAP
  const row = NODE_HEIGHT + ROW_GAP
  let leafSlot = 0
  let maxDepth = 0

  /** 后序放置子树，返回本节点中心 y；visited 过滤切断成环引用。 */
  const place = (fiber: FiberNode, depth: number): number => {
    visited.add(fiber)
    if (depth > maxDepth) maxDepth = depth
    const x = MARGIN + depth * column
    // uid 为 null 的 fiber 不可能有子节点（没有 uid 可被 parentUid 引用）。
    const children = (fiber.uid === null ? [] : tree.get(fiber.uid) ?? []).filter((c) => !visited.has(c))
    let centerY: number
    if (children.length === 0) {
      centerY = MARGIN + leafSlot * row + NODE_HEIGHT / 2
      leafSlot += 1
    } else {
      let first = 0
      let last = 0
      const childKeys: string[] = []
      children.forEach((child, index) => {
        const childY = place(child, depth + 1)
        childKeys.push(keys.get(child) ?? '')
        if (index === 0) first = childY
        last = childY
      })
      centerY = (first + last) / 2
      if (fiber.uid !== null) {
        const fromUid = fiber.uid
        for (const childKey of childKeys) {
          const childNode = nodes.get(childKey)
          const toUid = childNode?.fiber.uid
          if (childNode === undefined || toUid === null || toUid === undefined) continue
          edges.push({
            fromUid,
            toUid,
            x1: x + NODE_WIDTH,
            y1: centerY,
            x2: childNode.x,
            y2: childNode.y + childNode.height / 2,
          })
        }
      }
    }
    nodes.set(keys.get(fiber) ?? '', {
      x,
      y: centerY - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      depth,
      fiber,
    })
    return centerY
  }

  for (const root of tree.get(null) ?? []) if (!visited.has(root)) place(root, 0)
  // 成环兜底：互相引用成环、从根不可达的 fiber 按根级补放，保证全量可见。
  for (const fiber of fibers) if (!visited.has(fiber)) place(fiber, 0)

  return {
    nodes,
    edges,
    width: MARGIN * 2 + (maxDepth + 1) * NODE_WIDTH + maxDepth * COLUMN_GAP,
    height: MARGIN * 2 + Math.max(leafSlot, 1) * row - ROW_GAP,
  }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 轴对齐矩形相交（严格大于：贴边不算相交）。 */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * 校验三条布局不变量：
 * 1. 相邻节点净距 ≥ 8px（两矩形各外扩 4px 后相交即违规）；
 * 2. 挂载边包围盒不得穿过端点以外的节点矩形；
 * 3. 标签盒（节点矩形水平内缩 10px 的居中文字带）不得与任何边包围盒相交。
 * @param result 待校验的布局结果
 * @returns 违规描述列表；空数组表示通过
 */
export function validateLayout(result: LayoutResult): string[] {
  const violations: string[] = []
  const list = [...result.nodes.values()]
  const half = MIN_CLEARANCE / 2
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a === undefined) continue
    const aBox: Rect = { x: a.x - half, y: a.y - half, width: a.width + MIN_CLEARANCE, height: a.height + MIN_CLEARANCE }
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]
      if (b === undefined) continue
      const bBox: Rect = { x: b.x - half, y: b.y - half, width: b.width + MIN_CLEARANCE, height: b.height + MIN_CLEARANCE }
      if (intersects(aBox, bBox)) {
        violations.push(`净距 < ${MIN_CLEARANCE}px: ${a.fiber.name}(${a.fiber.uid ?? '?'}) × ${b.fiber.name}(${b.fiber.uid ?? '?'})`)
      }
    }
  }
  for (const edge of result.edges) {
    const box: Rect = {
      x: Math.min(edge.x1, edge.x2),
      y: Math.min(edge.y1, edge.y2),
      width: Math.abs(edge.x2 - edge.x1),
      height: Math.abs(edge.y2 - edge.y1),
    }
    for (const node of list) {
      if (node.fiber.uid === edge.fromUid || node.fiber.uid === edge.toUid) continue
      if (intersects(box, node)) {
        violations.push(`边穿节点: ${edge.fromUid}→${edge.toUid} × ${node.fiber.name}(${node.fiber.uid ?? '?'})`)
      }
      const label: Rect = {
        x: node.x + LABEL_INSET_X,
        y: node.y + (node.height - LABEL_BAND_HEIGHT) / 2,
        width: node.width - LABEL_INSET_X * 2,
        height: LABEL_BAND_HEIGHT,
      }
      if (intersects(box, label)) {
        violations.push(`标签压边: ${node.fiber.name}(${node.fiber.uid ?? '?'}) × ${edge.fromUid}→${edge.toUid}`)
      }
    }
  }
  return violations
}

/**
 * 布局引擎：持有上一有效布局。update 全量重排后校验，
 * 违规时回滚到 lastValid 并 console.warn 报告违规明细（绝不硬画无效布局）；
 * 首个布局即违规时返回空布局。P1 的 diff 为恒等桩，校验范围为整图；
 * P2 引入 changeKind 后校验收窄到变更子树。
 */
export class LayoutEngine {
  private lastValid: LayoutResult | null = null

  /**
   * 重排并校验；违规时回滚。
   * @param fibers 最新快照 fiber 列表
   * @returns 通过校验的新布局，或上一有效布局（或空布局）
   */
  update(fibers: FiberNode[]): LayoutResult {
    const next = tidyLayout(fibers)
    const violations = validateLayout(next)
    if (violations.length === 0) {
      this.lastValid = next
      return next
    }
    console.warn('[fiber-lens] DAG 布局校验失败，回滚到上一有效布局：', violations)
    return this.lastValid ?? { nodes: new Map(), edges: [], width: 0, height: 0 }
  }
}

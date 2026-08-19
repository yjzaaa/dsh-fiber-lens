/**
 * 焦点链布局层（管线的 layout 段，纯函数）。
 * 依赖跳数分层：列 = hop（焦点 0 列），自左向右；同列按名字排序垂直均布。
 * 布局完成后整体垂直平移，使焦点节点居于包围盒垂直中心。
 * @module dsh-fiber-lens/client/dag/chain-layout
 */
import type { FiberNode } from '../store.ts'
import type { ChainResult } from './chain.ts'

/** 节点宽（世界坐标 px）。 */
export const NODE_WIDTH = 168
/** 节点高（世界坐标 px）。 */
export const NODE_HEIGHT = 30
/** 相邻列水平净距。 */
export const COLUMN_GAP = 72
/** 相邻行垂直净距。 */
export const ROW_GAP = 16
/** 画布边距。 */
export const MARGIN = 24

/** 单个节点的布局结果。 */
export interface ChainLayoutNode {
  x: number
  y: number
  width: number
  height: number
  hop: number
  fiber: FiberNode
}

/** 布局后的服务依赖边（端点为世界坐标：provider 右缘中点 → consumer 左缘中点）。 */
export interface ChainLayoutEdge {
  fromUid: string
  toUid: string
  service: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 焦点链布局结果：render 层的唯一数据源。 */
export interface ChainLayout {
  nodes: Map<string, ChainLayoutNode>
  edges: ChainLayoutEdge[]
  width: number
  height: number
}

/** 父内排序：先名称后 uid，保证确定性。 */
const byName = (a: ChainLayoutNode, b: ChainLayoutNode): number =>
  a.fiber.name === b.fiber.name
    ? (a.fiber.uid ?? '').localeCompare(b.fiber.uid ?? '')
    : a.fiber.name.localeCompare(b.fiber.name)

/**
 * 布局焦点链。
 * @param chain 焦点链计算结果
 * @returns 节点矩形 + 服务边 + 画布包围盒
 */
export function layoutChain(chain: ChainResult): ChainLayout {
  const column = NODE_WIDTH + COLUMN_GAP
  const row = NODE_HEIGHT + ROW_GAP

  // 按 hop 分列（保 uid 以便回填）
  const columns = new Map<number, { uid: string; placed: ChainLayoutNode }[]>()
  let minHop = 0
  for (const [uid, node] of chain.nodes) {
    const placed: ChainLayoutNode = {
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      hop: node.hop,
      fiber: node.fiber,
    }
    const list = columns.get(node.hop)
    if (list === undefined) columns.set(node.hop, [{ uid, placed }])
    else list.push({ uid, placed })
    if (node.hop < minHop) minHop = node.hop
  }

  const nodes = new Map<string, ChainLayoutNode>()
  let focusY = 0
  let maxRows = 1
  for (const [hop, list] of columns) {
    list.sort((a, b) => byName(a.placed, b.placed))
    if (list.length > maxRows) maxRows = list.length
    list.forEach(({ uid, placed }, index) => {
      placed.x = MARGIN + (hop - minHop) * column
      placed.y = MARGIN + index * row
      nodes.set(uid, placed)
      if (uid === chain.focusUid) focusY = placed.y + NODE_HEIGHT / 2
    })
  }

  // 垂直居中焦点：整体平移，使焦点节点位于包围盒高度中点
  const height = MARGIN * 2 + maxRows * row - ROW_GAP
  const shift = height / 2 - focusY
  for (const node of nodes.values()) node.y += shift

  const hops = [...columns.keys()]
  const maxHop = hops.length > 0 ? Math.max(...hops) : 0
  const width = MARGIN * 2 + (maxHop - minHop) * column + NODE_WIDTH

  // 边端点：provider 右缘中点 → consumer 左缘中点
  const edges: ChainLayoutEdge[] = []
  for (const edge of chain.edges) {
    const from = nodes.get(edge.fromUid)
    const to = nodes.get(edge.toUid)
    if (from === undefined || to === undefined) continue
    edges.push({
      ...edge,
      x1: from.x + NODE_WIDTH,
      y1: from.y + NODE_HEIGHT / 2,
      x2: to.x,
      y2: to.y + NODE_HEIGHT / 2,
    })
  }

  return { nodes, edges, width, height }
}

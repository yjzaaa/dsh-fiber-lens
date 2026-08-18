/**
 * DAG 画布视图（管线 render 段）：只读 LayoutResult 渲染，不做布局计算。
 * 三档阅读深度（设计 v0.3 §4.3）：
 *   MAP  k < 1 且未选中   深度 ≤ 2 骨架显名 + 状态点，折叠子树挂 +N 徽标
 *   READ k ≥ 1 或有选中   名称全显，选中子树强制展开到全深
 *   FULL k ≥ 1.75         选中节点下方叠加 inject/provides 详情（事件历史属 P2）
 * @module dsh-fiber-lens/client/dag/canvas
 */
import { useMemo, useRef, useState } from 'react'
import type { FiberNode } from '../store.ts'
import { LayoutEngine, NODE_HEIGHT, NODE_WIDTH } from './layout.ts'
import { useViewport } from './viewport.ts'
import { useNodeTransitions } from './transitions.ts'
import styles from '../fiber-lens.module.css'

/** MAP 档骨架深度上限：布局深度 > 2 的节点默认折叠。 */
export const MAP_SKELETON_DEPTH = 2
/** 进入 READ 档的缩放阈值（100%）。 */
export const READ_ZOOM = 1
/** 进入 FULL 档的缩放阈值（175%）。 */
export const FULL_ZOOM = 1.75

/** 阅读深度档位。 */
export type ReadingTier = 'map' | 'read' | 'full'

/** DagCanvas props。 */
export interface DagCanvasProps {
  /** 最新快照的 fiber 列表。 */
  fibers: FiberNode[]
  /** 当前选中 uid（与列表面板共享同一份选中态）。 */
  selectedUid: string | null
  /** 节点点击回调（uid 为 null 的匿名节点不可选中，不触发）。 */
  onSelect: (uid: string) => void
}

/** 名称超宽截断（节点宽 168px，约容 20 字符）。 */
const clipName = (name: string): string => (name.length > 20 ? `${name.slice(0, 19)}…` : name)

/** 详情行列表截断。 */
const clipList = (items: string[]): string => {
  const joined = items.join(', ')
  return joined.length > 30 ? `${joined.slice(0, 29)}…` : joined
}

const TIER_LABELS: Record<ReadingTier, string> = {
  map: '地图',
  read: '阅读',
  full: '详情',
}

/**
 * DAG 画布组件：挂载树 SVG + 视口交互 + 三档阅读深度 + 折叠/展开。
 * @param props 见 DagCanvasProps
 * @returns 画布元素
 */
export function DagCanvas({ fibers, selectedUid, onSelect }: DagCanvasProps) {
  // 引擎持有 lastValid，必须跨渲染稳定；校验失败回滚在引擎内部完成。
  const [engine] = useState(() => new LayoutEngine())
  const layout = useMemo(() => engine.update(fibers), [engine, fibers])
  const transitions = useNodeTransitions(layout)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewport = useViewport(svgRef)
  const [panning, setPanning] = useState(false)
  // 折叠覆盖表：key → 是否折叠；未覆盖时按默认规则（深度 ≥ 2 且有子节点即折叠）。
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())

  const k = viewport.transform.k
  const tier: ReadingTier = k >= FULL_ZOOM ? 'full' : selectedUid !== null || k >= READ_ZOOM ? 'read' : 'map'

  // 由布局结果派生的父子索引与后代计数（render 侧只读派生，不参与布局计算）。
  const derived = useMemo(() => {
    const parents = new Map<string, string>()
    const children = new Map<string, string[]>()
    for (const edge of layout.edges) {
      parents.set(edge.toUid, edge.fromUid)
      const list = children.get(edge.fromUid)
      if (list === undefined) children.set(edge.fromUid, [edge.toUid])
      else list.push(edge.toUid)
    }
    return { parents, children }
  }, [layout])

  // READ 档语义：选中节点 + 其祖先链 + 其整个子树强制可见（展开到全深）。
  const forced = useMemo(() => {
    const set = new Set<string>()
    if (selectedUid === null || !layout.nodes.has(selectedUid)) return set
    set.add(selectedUid)
    let cur = selectedUid
    for (;;) {
      const parent = derived.parents.get(cur)
      if (parent === undefined) break
      set.add(parent)
      cur = parent
    }
    const queue = [selectedUid]
    while (queue.length > 0) {
      const key = queue.pop() ?? ''
      for (const child of derived.children.get(key) ?? []) {
        if (!set.has(child)) {
          set.add(child)
          queue.push(child)
        }
      }
    }
    return set
  }, [layout, derived, selectedUid])

  // 可见集合 + 折叠集合 + 每个节点被隐藏的后代数（+N 徽标）。
  const visibility = useMemo(() => {
    const collapsedEffective = (key: string): boolean => {
      if (!derived.children.has(key)) return false
      if (forced.has(key)) return false
      const node = layout.nodes.get(key)
      return overrides.get(key) ?? (node?.depth ?? 0) >= MAP_SKELETON_DEPTH
    }
    const visibleSet = new Set<string>()
    const collapsedSet = new Set<string>()
    for (const key of layout.nodes.keys()) {
      if (collapsedEffective(key)) collapsedSet.add(key)
      let hidden = false
      let cur = key
      for (;;) {
        const parent = derived.parents.get(cur)
        if (parent === undefined) break
        if (collapsedEffective(parent)) {
          hidden = true
          break
        }
        cur = parent
      }
      if (!hidden) visibleSet.add(key)
    }
    const hiddenCounts = new Map<string, number>()
    const countHidden = (key: string): number => {
      const cached = hiddenCounts.get(key)
      if (cached !== undefined) return cached
      let sum = 0
      for (const child of derived.children.get(key) ?? []) {
        if (!visibleSet.has(child)) sum += 1
        sum += countHidden(child)
      }
      hiddenCounts.set(key, sum)
      return sum
    }
    for (const key of layout.nodes.keys()) countHidden(key)
    return { visibleSet, collapsedSet, hiddenCounts }
  }, [layout, derived, overrides, forced])

  const toggleCollapse = (key: string): void => {
    setOverrides((cur) => {
      const node = layout.nodes.get(key)
      const fallback = (node?.depth ?? 0) >= MAP_SKELETON_DEPTH
      const next = new Map(cur)
      next.set(key, !(cur.get(key) ?? fallback))
      return next
    })
  }

  const t = viewport.transform
  return (
    <div className={styles.dagRoot}>
      <svg
        ref={svgRef}
        className={`${styles.dagSvg} ${panning ? styles.dagSvgPanning : ''}`}
        onPointerDown={(event) => {
          viewport.handlers.onPointerDown(event)
          setPanning(true)
        }}
        onPointerMove={viewport.handlers.onPointerMove}
        onPointerUp={(event) => {
          viewport.handlers.onPointerUp(event)
          setPanning(false)
        }}
        onDoubleClick={viewport.handlers.onDoubleClick}
      >
        <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
          {layout.edges.map((edge) => {
            if (!visibility.visibleSet.has(edge.fromUid) || !visibility.visibleSet.has(edge.toUid)) return null
            const midX = (edge.x1 + edge.x2) / 2
            return (
              <path
                key={`${edge.fromUid}->${edge.toUid}`}
                className={styles.dagEdge}
                d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
              />
            )
          })}
          {[...layout.nodes.entries()].map(([key, node]) => {
            if (!visibility.visibleSet.has(key)) return null
            const fiber = node.fiber
            const collapsed = visibility.collapsedSet.has(key)
            const badge = visibility.hiddenCounts.get(key) ?? 0
            const isSelected = selectedUid !== null && fiber.uid === selectedUid
            const showText = tier !== 'map' || node.depth <= MAP_SKELETON_DEPTH
            const detailLines: string[] = []
            if (fiber.inject.length > 0) detailLines.push(`inject: ${clipList(fiber.inject)}`)
            if (fiber.provides.length > 0) detailLines.push(`provides: ${clipList(fiber.provides)}`)
            if (detailLines.length === 0) detailLines.push('（无 inject / provides）')
            return (
              <g
                key={key}
                transform={`translate(${node.x} ${node.y})`}
                className={`${styles.dagNode}${transitions.entering.has(key) ? ` ${styles.dagEnter}` : ''}`}
                onClick={() => {
                  if (viewport.hasDragged()) return
                  if (fiber.uid !== null) onSelect(fiber.uid)
                }}
              >
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  className={`${styles.dagNodeRect} ${styles[`fill-${fiber.state}`] ?? ''} ${isSelected ? styles.dagSelected : ''}`}
                />
                <circle cx={10} cy={NODE_HEIGHT / 2} r={3.5} className={styles[`solid-${fiber.state}`] ?? ''} />
                {showText && (
                  <text x={20} y={NODE_HEIGHT / 2 + 4} className={styles.dagLabel}>{clipName(fiber.name)}</text>
                )}
                {collapsed && badge > 0 && (
                  <g
                    onClick={(event) => {
                      event.stopPropagation()
                      if (viewport.hasDragged()) return
                      toggleCollapse(key)
                    }}
                  >
                    <rect x={NODE_WIDTH - 32} y={(NODE_HEIGHT - 16) / 2} width={28} height={16} rx={8} className={styles.dagBadgeRect} />
                    <text x={NODE_WIDTH - 18} y={NODE_HEIGHT / 2 + 3.5} textAnchor="middle" className={styles.dagBadgeText}>+{badge}</text>
                  </g>
                )}
                {tier === 'full' && isSelected && (
                  <g>
                    <rect
                      x={0}
                      y={NODE_HEIGHT + 6}
                      width={NODE_WIDTH}
                      height={detailLines.length * 13 + 8}
                      rx={4}
                      className={styles.dagDetailBox}
                    />
                    {detailLines.map((line, index) => (
                      <text key={line} x={8} y={NODE_HEIGHT + 6 + 13 * (index + 1) - 3} className={styles.dagDetailText}>{line}</text>
                    ))}
                  </g>
                )}
              </g>
            )
          })}
          {[...transitions.leaving.entries()].map(([key, node]) => (
            <g key={`ghost:${key}`} transform={`translate(${node.x} ${node.y})`} className={`${styles.dagNode} ${styles.dagLeave}`}>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={6}
                className={`${styles.dagNodeRect} ${styles[`fill-${node.fiber.state}`] ?? ''}`}
              />
              <text x={20} y={NODE_HEIGHT / 2 + 4} className={styles.dagLabel}>{clipName(node.fiber.name)}</text>
            </g>
          ))}
        </g>
      </svg>
      <div className={styles.dagHint}>
        {layout.nodes.size === 0 && fibers.length > 0
          ? '布局校验失败，已回滚（详见 console）'
          : `${TIER_LABELS[tier]} · ${Math.round(k * 100)}% · 滚轮缩放 · 拖拽平移 · 双击复位`}
      </div>
    </div>
  )
}

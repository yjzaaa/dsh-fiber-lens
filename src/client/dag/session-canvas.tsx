/**
 * 会话镜头画布（设计 v0.4 §5）：只渲染当前会话参与的 fiber。
 * 三态模型：未参与 = 不渲染；已参与 = 40% 不透明度；正在经手 = 全不透明 + 发光描边。
 * 正在经手的节点在标签下方常驻一行在飞操作（参数摘要 + 关口），
 * result 回来即消失，节点退回已参与暗色——节点内绝不显示历史。
 * 布局复用 tidy tree + LayoutEngine 回滚；未匹配到 fiber 的参与名渲染为无状态简节点。
 * @module dsh-fiber-lens/client/dag/session-canvas
 */
import { useMemo, useRef, useState } from 'react'
import type { FiberNode, ParticipationSnapshot } from '../store.ts'
import { LayoutEngine, NODE_HEIGHT, NODE_WIDTH } from './layout.ts'
import { useViewport } from './viewport.ts'
import { useNodeTransitions } from './transitions.ts'
import styles from '../fiber-lens.module.css'

/** SessionCanvas props。 */
export interface SessionCanvasProps {
  /** 最新快照的全量 fiber 列表（参与名按 name 匹配）。 */
  fibers: FiberNode[]
  /** 当前参与数据；尚未拉到首批数据时为 null。 */
  participation: ParticipationSnapshot | null
  /** 当前会话 id；无当前会话时渲染空态提示。 */
  sessionId: string | null
}

/** 在飞摘要与 +N 角标的单行文案截断（节点宽 168px 的下方间隙行）。 */
const clipSummary = (text: string): string => (text.length > 30 ? `${text.slice(0, 29)}…` : text)

/** 每个参与名取一个代表实例：优先 active，再按 uid 字典序（确定性）。 */
function pickRepresentatives(fibers: FiberNode[], participants: ReadonlySet<string>): FiberNode[] {
  const byName = new Map<string, FiberNode[]>()
  for (const fiber of fibers) {
    if (!participants.has(fiber.name)) continue
    const list = byName.get(fiber.name)
    if (list === undefined) byName.set(fiber.name, [fiber])
    else list.push(fiber)
  }
  const picked: FiberNode[] = []
  for (const list of byName.values()) {
    list.sort((a, b) =>
      Number(a.state !== 'active') - Number(b.state !== 'active') || (a.uid ?? '').localeCompare(b.uid ?? ''))
    const representative = list[0]
    if (representative !== undefined) picked.push(representative)
  }
  // 参与名在快照里没有对应 fiber（映射兜底名、已卸载插件）：无状态简节点。
  for (const name of participants) {
    if (byName.has(name)) continue
    picked.push({
      uid: `#session:${name}`,
      name,
      state: 'active',
      depth: 0,
      parentUid: null,
      inject: [],
      missing: [],
      provides: [],
    })
  }
  return picked
}

/**
 * 会话镜头画布组件。
 * @param props 见 SessionCanvasProps
 * @returns 画布元素或空态提示
 */
export function SessionCanvas({ fibers, participation, sessionId }: SessionCanvasProps) {
  // 引擎持有 lastValid，必须跨渲染稳定；会话镜头与机制镜头各自持有独立引擎。
  const [engine] = useState(() => new LayoutEngine())
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewport = useViewport(svgRef)
  const [panning, setPanning] = useState(false)

  const participants = useMemo(
    () => new Set(participation?.participants ?? []),
    [participation],
  )
  // 在飞集合按 fiberName 归组：同一 fiber 并发调用显示最新一个 + +N 角标（设计 §5.4 纪律）。
  const inflightByFiber = useMemo(() => {
    const map = new Map<string, { latest: string; gate: string; count: number }>()
    for (const entry of participation?.inflight ?? []) {
      const cur = map.get(entry.fiberName)
      map.set(entry.fiberName, {
        latest: entry.argsSummary,
        gate: entry.gate,
        count: (cur?.count ?? 0) + 1,
      })
    }
    return map
  }, [participation])

  const displayFibers = useMemo(
    () => pickRepresentatives(fibers, participants),
    [fibers, participants],
  )
  const layout = useMemo(() => engine.update(displayFibers), [engine, displayFibers])
  const transitions = useNodeTransitions(layout)

  if (sessionId === null) {
    return <div className={styles.empty}>没有当前会话——打开一个会话后，这里会实时显示正在干活的插件。</div>
  }
  if (participation === null) {
    return <div className={styles.empty}>等待参与数据…</div>
  }
  if (participants.size === 0) {
    return <div className={styles.empty}>本会话暂无插件参与记录——发一条消息试试。</div>
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
            const fiber = node.fiber
            const inflight = inflightByFiber.get(fiber.name)
            const live = inflight !== undefined
            const cls = `${styles.dagNode} ${live ? styles.sessionLive : styles.sessionDim}${transitions.entering.has(key) ? ` ${styles.dagEnter}` : ''}`
            return (
              <g key={key} transform={`translate(${node.x} ${node.y})`} className={cls}>
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  className={`${styles.dagNodeRect} ${styles[`fill-${fiber.state}`] ?? ''}`}
                />
                <circle cx={10} cy={NODE_HEIGHT / 2} r={3.5} className={styles[`solid-${fiber.state}`] ?? ''} />
                <text x={20} y={NODE_HEIGHT / 2 + 4} className={styles.dagLabel}>
                  {fiber.name.length > 20 ? `${fiber.name.slice(0, 19)}…` : fiber.name}
                </text>
                {live && (
                  <text x={20} y={NODE_HEIGHT + 11} className={styles.sessionInflightText}>
                    ▸ {clipSummary(inflight.latest)}{inflight.count > 1 ? ` +${inflight.count - 1}` : ''} · {inflight.gate}
                  </text>
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
              <text x={20} y={NODE_HEIGHT / 2 + 4} className={styles.dagLabel}>
                {node.fiber.name.length > 20 ? `${node.fiber.name.slice(0, 19)}…` : node.fiber.name}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className={styles.dagHint}>
        {`会话镜头 · ${participants.size} 参与 · ${inflightByFiber.size} 在飞 · ${Math.round(t.k * 100)}%`}
      </div>
    </div>
  )
}

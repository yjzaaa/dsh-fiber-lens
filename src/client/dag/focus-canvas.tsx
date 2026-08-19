/**
 * 焦点链画布（管线的 render 段）：只读 ChainLayout 渲染，不做计算。
 * 注意力纪律（设计 v0.5 §3.4）：链外节点不渲染；焦点节点发光描边；
 * 服务依赖边为唯一边类型（实线 + 流向箭头 + 服务名标签）。
 * 动画纪律（设计 v0.5 §5）：视口授予、一次性消费、状态 diff morph。
 * 焦点切换（设计 §3.3）：镜头飞行接管相机（300ms CSS transition），跳过锚点回放。
 * @module dsh-fiber-lens/client/dag/focus-canvas
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FiberActivity, FiberNode, ServiceRow } from '../store.ts'
import { buildChain } from './chain.ts'
import { layoutChain, NODE_HEIGHT, NODE_WIDTH } from './chain-layout.ts'
import { useViewport, type CameraAnchor } from './viewport.ts'
import type { SnapshotDiff } from './diff.ts'
import styles from '../fiber-lens.module.css'

/** 名称超宽截断（节点宽 168px，约容 20 字符）。 */
const clipName = (name: string): string => (name.length > 20 ? `${name.slice(0, 19)}…` : name)

export interface FocusCanvasProps {
  fibers: FiberNode[]
  services: ServiceRow[]
  /** 每个 fiber 的活动热度。 */
  activities: Record<string, FiberActivity>
  /** 焦点 uid；null 时由调用侧先选默认值，这里渲染空态。 */
  focusUid: string | null
  /** 点击节点：接管焦点（手动模式）。 */
  onFocus: (uid: string) => void
  /** 跟随模式（提示文案用：自动跟随 / 手动焦点）。 */
  followMode?: 'auto' | 'manual'
  /** 用户在画布上的操作心跳（平移/缩放/点按）：重置自动跟随的空闲计时。 */
  onActivity?: () => void
  /**
   * 当前快照的 diff 结果（用于动画驱动）。
   * 可选：panel 接线（t3）完成前缺省 null，动画层静默不激活。
   */
  diff?: SnapshotDiff | null
}

export function FocusCanvas({ fibers, services, activities, focusUid, onFocus, followMode = 'auto', onActivity, diff = null }: FocusCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewport = useViewport(svgRef)
  const [panning, setPanning] = useState(false)
  
  // 视口内节点集合：用于视口授予（只有可见节点才挂动画类）
  const [visibleNodes, setVisibleNodes] = useState<Set<string>>(new Set())
  
  // 记录已经消费过的 diff 事件（一次性消费）
  const consumedDiffRef = useRef<SnapshotDiff | null>(null)

  // 一次性消费（设计 v0.5 §5.2）：diff 动画类挂载后延迟 450ms（覆盖 enter/leave/morph
  // 的 400ms 时长）再标记消费。若提交后立即消费，visibleNodes effect 引发的紧随重渲染
  // 会把刚挂上的动画类当场摘除；同 diff 对象的重渲染不会重放动画（class 串不变，
  // React 不动 className），450ms 后消费保证平移回看不回放历史。
  useEffect(() => {
    if (diff === null) return
    const timer = setTimeout(() => {
      consumedDiffRef.current = diff
    }, 450)
    return () => clearTimeout(timer)
  }, [diff])

  const built = useMemo(() => {
    if (focusUid === null) return null
    const chain = buildChain(focusUid, fibers, services)
    if (chain === null) return null
    return { chain, layout: layoutChain(chain) }
  }, [fibers, services, focusUid])
  const layout = built?.layout ?? null
  const isolated = built?.chain.isolated ?? false
  const truncated = built?.chain.truncated ?? new Map<string, number>()

  // 相机补偿（设计 v0.5 §4.2）：布局重算前记录视口中心的世界坐标，
  // 重算提交后反解 transform，让同一世界坐标留在原屏幕位置。
  // 两个 layout effect 按声明顺序执行：先按上一提交记录的锚点回放（仅 layout 变化时），
  // 再为下一提交重新记录锚点。capture/restore 是 useCallback 稳定引用，可作依赖。
  const anchorRef = useRef<CameraAnchor | null>(null)
  const { captureAnchor, restoreAnchor, flyTo } = viewport

  // 焦点切换检测（声明在相机补偿回放之前，同提交内先执行）：焦点变化时相机由
  // 镜头飞行接管——跳过锚点回放（否则旧视口中心被钉住，飞行起点会落在空处），
  // 并记下飞行请求，等布局提交后的 passive effect 里执行（此时节点已在新位置渲染一帧）。
  const prevFocusRef = useRef<string | null>(null)
  const focusSwitchRef = useRef(false)
  const pendingFlyRef = useRef(false)
  useLayoutEffect(() => {
    if (prevFocusRef.current !== focusUid) {
      prevFocusRef.current = focusUid
      focusSwitchRef.current = true
      pendingFlyRef.current = true
    }
  }, [focusUid])

  useLayoutEffect(() => {
    if (focusSwitchRef.current) {
      focusSwitchRef.current = false
      anchorRef.current = null
      return
    }
    const anchor = anchorRef.current
    if (anchor !== null) restoreAnchor(anchor)
  }, [layout, restoreAnchor])
  useLayoutEffect(() => {
    anchorRef.current = captureAnchor()
  })

  // 镜头飞行（设计 §3.3）：焦点切换后把新焦点节点中心飞到视口中心。
  // 在 passive effect 执行：布局提交已绘制首帧，CSS transition 从当前画面平滑起飞。
  useEffect(() => {
    if (!pendingFlyRef.current) return
    if (layout === null || focusUid === null) return
    pendingFlyRef.current = false
    const node = layout.nodes.get(focusUid)
    if (node !== undefined) flyTo(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2)
  }, [layout, focusUid, flyTo])
  
  // 计算视口内节点：布局完成后，检查哪些节点在可见世界矩形内
  useEffect(() => {
    if (layout === null || svgRef.current === null) return
    const svg = svgRef.current
    const rect = svg.getBoundingClientRect()
    const t = viewport.transform
    
    // 将屏幕坐标转换为世界坐标
    const worldLeft = -t.x / t.k
    const worldTop = -t.y / t.k
    const worldRight = worldLeft + rect.width / t.k
    const worldBottom = worldTop + rect.height / t.k
    
    const visible = new Set<string>()
    for (const [uid, node] of layout.nodes) {
      // 检查节点是否与视口相交
      if (node.x + NODE_WIDTH >= worldLeft && 
          node.x <= worldRight && 
          node.y + NODE_HEIGHT >= worldTop && 
          node.y <= worldBottom) {
        visible.add(uid)
      }
    }
    setVisibleNodes(visible)
  }, [layout, viewport.transform])
  
  // 判断节点是否应该显示动画
  const shouldAnimate = (uid: string): 'enter' | 'leave' | 'morph' | null => {
    if (diff === null || consumedDiffRef.current === diff) return null
    
    // 视口授予：只有可见节点才挂动画类
    if (!visibleNodes.has(uid)) return null
    
    if (diff.added.includes(uid)) return 'enter'
    if (diff.removed.includes(uid)) return 'leave'
    if (diff.stateChanges.some((c) => c.uid === uid)) return 'morph'
    return null
  }

  const t = viewport.transform
  return (
    <div className={styles.dagRoot}>
      <svg
        ref={svgRef}
        className={`${styles.dagSvg} ${panning ? styles.dagSvgPanning : ''}`}
        onPointerDown={(event) => {
          onActivity?.()
          viewport.handlers.onPointerDown(event)
          setPanning(true)
        }}
        onWheel={() => onActivity?.()}
        onPointerMove={viewport.handlers.onPointerMove}
        onPointerUp={(event) => {
          viewport.handlers.onPointerUp(event)
          setPanning(false)
        }}
        onDoubleClick={() => {
          // §4.3 双击 = 适应内容（fit-to-content），语义由 viewport hook 收口。
          if (layout !== null) viewport.handlers.onDoubleClick({ width: layout.width, height: layout.height })
        }}
      >
        <defs>
          <marker id="fl-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" className={styles.dagArrowHead} />
          </marker>
        </defs>
        {layout !== null && (
          // 相机容器：style transform（非 attribute）才能被 CSS transition 驱动；
          // transformOrigin 显式 0 0 与 SVG attribute 语义对齐。飞行中挂 dagCameraFly。
          <g
            className={viewport.flying ? styles.dagCameraFly : undefined}
            style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})`, transformOrigin: '0 0' }}
          >
            {layout.edges.map((edge) => {
              const midX = (edge.x1 + edge.x2) / 2
              return (
                <g key={`${edge.fromUid}->${edge.toUid}:${edge.service}`}>
                  <path
                    className={styles.dagChainEdge}
                    markerEnd="url(#fl-arrow)"
                    d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                  />
                  <text
                    x={midX}
                    y={(edge.y1 + edge.y2) / 2 - 4}
                    textAnchor="middle"
                    className={styles.dagEdgeLabel}
                  >{edge.service}</text>
                </g>
              )
            })}
            {[...layout.nodes.entries()].map(([uid, node]) => {
              const fiber = node.fiber
              const isFocus = uid === focusUid
              const badge = truncated.get(uid) ?? 0
              const activity = activities[uid]
              const heat = activity?.heat ?? 0
              const isHot = heat > 0.5
              const isWarm = heat > 0 && !isHot
              
              // 动画类：视口授予 + 一次性消费
              const animKind = shouldAnimate(uid)
              const animClass = animKind === 'enter' ? styles.dagEnter
                : animKind === 'leave' ? styles.dagLeave
                : animKind === 'morph' ? styles.dagMorph
                : ''
              
              // 动态类名：lifecycle state + activity heat + 动画
              const rectClass = `${styles.dagNodeRect} ${styles[`fill-${fiber.state}`] ?? ''} ${isFocus ? styles.dagFocus : ''} ${isHot ? styles.dagNodeHot : ''} ${isWarm ? styles.dagNodeWarm : ''}`
              
              return (
                <g
                  key={uid}
                  transform={`translate(${node.x} ${node.y})`}
                  className={`${styles.dagNode} ${isHot ? styles.dagNodeAnim : ''} ${animClass}`}
                  onClick={() => {
                    if (viewport.hasDragged()) return
                    if (!isFocus && fiber.uid !== null) onFocus(fiber.uid)
                  }}
                >
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={6}
                    className={rectClass}
                  />
                  {/* Heat 指示器：右上角小点 */}
                  {heat > 0 && (
                    <circle
                      cx={NODE_WIDTH - 8}
                      cy={8}
                      r={3}
                      className={`${styles.heatDot} ${isHot ? styles.heatDotHot : styles.heatDotWarm}`}
                    />
                  )}
                  <circle cx={10} cy={NODE_HEIGHT / 2} r={3.5} className={styles[`solid-${fiber.state}`] ?? ''} />
                  <text x={20} y={NODE_HEIGHT / 2 + 4} className={styles.dagLabel}>{clipName(fiber.name)}</text>
                  {node.hop !== 0 && (
                    <text x={NODE_WIDTH - 6} y={10} textAnchor="end" className={styles.dagHop}>
                      {node.hop > 0 ? `+${node.hop}` : node.hop}
                    </text>
                  )}
                  {badge > 0 && (
                    <text x={NODE_WIDTH - 6} y={NODE_HEIGHT - 4} textAnchor="end" className={styles.dagBadgeText}>+{badge}</text>
                  )}
                </g>
              )
            })}
          </g>
        )}
      </svg>
      <div className={styles.dagHint}>
        {focusUid === null
          ? '在列表中点击一个插件实例，聚焦它的上下游链'
          : layout === null
            ? '焦点节点不在当前快照中'
            : isolated
              ? '该插件独立运行（无 inject / provides）'
              : `⛓ ${layout.nodes.size} 节点 · ${layout.edges.length} 服务边 · ${followMode === 'auto' ? '自动跟随' : '手动焦点（Esc 恢复跟随）'} · 滚轮缩放 · 拖拽平移 · 双击适应全图`}
      </div>
      
      {/* 消费标记：当前 diff 已被动画消费 */}
      {diff !== null && consumedDiffRef.current !== diff && (
        <span ref={() => { consumedDiffRef.current = diff }} style={{ display: 'none' }} />
      )}
    </div>
  )
}

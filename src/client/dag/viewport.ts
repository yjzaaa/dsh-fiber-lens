/**
 * 视口变换 hook（手写，零依赖）：滚轮缩放 0.2x–3x（锚定光标）、
 * 指针拖拽平移、双击适应内容（fit-to-content，设计 v0.5 §4.3：不复位回原点）、
 * 镜头飞行（设计 §3.3：焦点切换 300ms CSS transition，不瞬移）。
 * transform = { x, y, k }，语义 translate(x, y) scale(k)。
 * @module dsh-fiber-lens/client/dag/viewport
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

/** 最小缩放倍率。 */
export const MIN_ZOOM = 0.2
/** 最大缩放倍率。 */
export const MAX_ZOOM = 3

/** 视口变换：屏幕坐标 = 世界坐标 × k + (x, y)。 */
export interface ViewportTransform {
  x: number
  y: number
  k: number
}

const IDENTITY: ViewportTransform = { x: 0, y: 0, k: 1 }
/** 位移超过该阈值（px）判定为拖拽，用于抑制紧随其后的 click 误选中。 */
const DRAG_THRESHOLD = 4
/** 镜头飞行时长（设计 v0.5 §3.3：300ms CSS transition；flying 标志同步窗口）。 */
export const FLY_MS = 300

/** useViewport 返回的事件处理器集。 */
export interface ViewportHandlers {
  /**
   * 滚轮缩放（原生 WheelEvent）。由 hook 内部以非 passive 监听挂接：
   * React 根委托的 wheel 是 passive，合成事件里 preventDefault 无效，
   * 无法阻止滚轮穿透滚动面板 body。导出仅供测试或手动挂接。
   */
  onWheel: (event: WheelEvent) => void
  /** 指针按下：开始平移（仅主键）。 */
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void
  /** 指针移动：平移中。 */
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void
  /** 指针抬起：结束平移。 */
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void
  /**
   * 双击：适应内容（fit-to-content），把给定内容包围盒完整居中入镜。
   * 设计 v0.5 §4.3：双击复位的正确语义是「永远看到内容」，不是回原点。
   */
  onDoubleClick: (bounds: { width: number; height: number }) => void
}

/**
 * 相机锚点（设计 v0.5 §4.2 相机补偿）：
 * 布局重算前记录视口中心的世界坐标及其屏幕位置。
 */
export interface CameraAnchor {
  /** 视口中心的世界坐标 x。 */
  wx: number
  /** 视口中心的世界坐标 y。 */
  wy: number
  /** 视口中心的屏幕坐标 x（相对 SVG 元素）。 */
  sx: number
  /** 视口中心的屏幕坐标 y（相对 SVG 元素）。 */
  sy: number
}

/** useViewport 返回值。 */
export interface Viewport {
  transform: ViewportTransform
  handlers: ViewportHandlers
  /**
   * 读取并复位「上次指针交互是拖拽」标记；节点 onClick 用它抑制拖拽后的误选中。
   * @returns 上次指针序列为拖拽返回 true（只报一次）
   */
  hasDragged: () => boolean
  /** 适应内容：缩放平移使给定包围盒完整居中入镜（双击复位的正确语义）。 */
  fitContent: (bounds: { width: number; height: number }) => void
  /**
   * 相机补偿·记录（§4.2）：布局重算前调用，
   * 捕获视口中心的世界坐标与屏幕位置；元素不可见时返回 null。
   */
  captureAnchor: () => CameraAnchor | null
  /**
   * 相机补偿·回放（§4.2）：布局重算后调用，反解 transform（保持 k），
   * 让锚点记录的同一世界坐标留在原屏幕位置。
   */
  restoreAnchor: (anchor: CameraAnchor) => void
  /**
   * 镜头飞行（§3.3）：平移（保持 k）使世界坐标点 (wx, wy) 落到视口中心。
   * flying 标志置位 FLY_MS，期间画布给相机容器挂 CSS transition 类；
   * 任何手动交互（滚轮/拖拽）立即取消飞行。
   */
  flyTo: (wx: number, wy: number) => void
  /** 镜头飞行中标志：true 时画布给相机容器挂 300ms transition 类。 */
  flying: boolean
}

/**
 * 手写视口 hook：缩放/平移/复位。
 * @param ref 目标 SVG 元素 ref
 * @returns 当前变换 + 事件处理器 + 拖拽标记读取器
 */
export function useViewport(ref: RefObject<SVGSVGElement | null>): Viewport {
  const [transform, setTransform] = useState<ViewportTransform>(IDENTITY)
  const live = useRef(transform)
  useEffect(() => {
    live.current = transform
  }, [transform])
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; k: number } | null>(null)
  const dragged = useRef(false)
  const [flying, setFlying] = useState(false)
  const flyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** 取消进行中的镜头飞行（手动交互优先；§5.7 reduced-motion 直接终态、不挂飞行标志）。 */
  const cancelFlight = useCallback((): void => {
    if (flyTimer.current !== undefined) clearTimeout(flyTimer.current)
    flyTimer.current = undefined
    setFlying(false)
  }, [])

  useEffect(() => cancelFlight, [cancelFlight])

  /** 以光标为锚点缩放：保持光标下的世界坐标不动。 */
  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number): void => {
    const el = ref.current
    if (el === null) return
    cancelFlight()
    const rect = el.getBoundingClientRect()
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    setTransform((t) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * Math.exp(-deltaY * 0.0015)))
      const scale = k / t.k
      return { k, x: cx - (cx - t.x) * scale, y: cy - (cy - t.y) * scale }
    })
  }, [ref, cancelFlight])

  const onWheel = useCallback((event: WheelEvent): void => {
    zoomAt(event.clientX, event.clientY, event.deltaY)
  }, [zoomAt])

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const listener = (event: WheelEvent): void => {
      event.preventDefault()
      onWheel(event)
    }
    el.addEventListener('wheel', listener, { passive: false })
    return () => el.removeEventListener('wheel', listener)
  }, [ref, onWheel])

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    cancelFlight()
    event.currentTarget.setPointerCapture(event.pointerId)
    const t = live.current
    drag.current = { startX: event.clientX, startY: event.clientY, baseX: t.x, baseY: t.y, k: t.k }
    dragged.current = false
  }, [cancelFlight])

  const onPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    if (d === null) return
    const dx = event.clientX - d.startX
    const dy = event.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) dragged.current = true
    setTransform({ x: d.baseX + dx, y: d.baseY + dy, k: d.k })
  }, [])

  const onPointerUp = useCallback((): void => {
    drag.current = null
  }, [])

  const fitContent = useCallback((bounds: { width: number; height: number }): void => {
    const el = ref.current
    if (el === null || bounds.width <= 0 || bounds.height <= 0) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rect.width / bounds.width, rect.height / bounds.height)))
    setTransform({ k, x: (rect.width - bounds.width * k) / 2, y: (rect.height - bounds.height * k) / 2 })
  }, [ref])

  /** 双击 = 适应内容（§4.3），不回原点。 */
  const onDoubleClick = useCallback((bounds: { width: number; height: number }): void => {
    fitContent(bounds)
  }, [fitContent])

  const hasDragged = useCallback((): boolean => {
    const value = dragged.current
    dragged.current = false
    return value
  }, [])

  const captureAnchor = useCallback((): CameraAnchor | null => {
    const el = ref.current
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const sx = rect.width / 2
    const sy = rect.height / 2
    const t = live.current
    return { sx, sy, wx: (sx - t.x) / t.k, wy: (sy - t.y) / t.k }
  }, [ref])

  const restoreAnchor = useCallback((anchor: CameraAnchor): void => {
    setTransform((t) => {
      const x = anchor.sx - anchor.wx * t.k
      const y = anchor.sy - anchor.wy * t.k
      // 布局重算本身不改 transform 时回放是恒等：返回原引用避免多余渲染。
      if (x === t.x && y === t.y) return t
      return { k: t.k, x, y }
    })
  }, [])

  const flyTo = useCallback((wx: number, wy: number): void => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    // §5.7 reduced-motion：静态回退，直接跳到终态，不挂 flying 标志。
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    setTransform((t) => ({ k: t.k, x: rect.width / 2 - wx * t.k, y: rect.height / 2 - wy * t.k }))
    if (reduced) return
    if (flyTimer.current !== undefined) clearTimeout(flyTimer.current)
    setFlying(true)
    flyTimer.current = setTimeout(() => {
      flyTimer.current = undefined
      setFlying(false)
    }, FLY_MS)
  }, [ref])

  return {
    transform,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    hasDragged,
    fitContent,
    captureAnchor,
    restoreAnchor,
    flyTo,
    flying,
  }
}

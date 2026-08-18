/**
 * 视口变换 hook（手写，零依赖）：滚轮缩放 0.2x–3x（锚定光标）、
 * 指针拖拽平移、双击复位。transform = { x, y, k }，语义 translate(x, y) scale(k)。
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
  /** 双击：复位到恒等变换。 */
  onDoubleClick: () => void
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

  /** 以光标为锚点缩放：保持光标下的世界坐标不动。 */
  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number): void => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    setTransform((t) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * Math.exp(-deltaY * 0.0015)))
      const scale = k / t.k
      return { k, x: cx - (cx - t.x) * scale, y: cy - (cy - t.y) * scale }
    })
  }, [ref])

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
    event.currentTarget.setPointerCapture(event.pointerId)
    const t = live.current
    drag.current = { startX: event.clientX, startY: event.clientY, baseX: t.x, baseY: t.y, k: t.k }
    dragged.current = false
  }, [])

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

  const onDoubleClick = useCallback((): void => {
    setTransform(IDENTITY)
  }, [])

  const hasDragged = useCallback((): boolean => {
    const value = dragged.current
    dragged.current = false
    return value
  }, [])

  return {
    transform,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    hasDragged,
  }
}

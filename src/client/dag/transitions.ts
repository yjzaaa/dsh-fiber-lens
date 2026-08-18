/**
 * diff → animate 管线的 diff 段：纯函数键集对比 + 进出场合拍 hook。
 * 动画全部由 changeKind 驱动的 CSS 类完成（设计 v0.4 §6/§8），本模块只负责
 * 算出"哪些键新增 / 哪些键消失"，并给消失节点 400ms 的灰化淡出窗口。
 * @module dsh-fiber-lens/client/dag/transitions
 */
import { useEffect, useRef, useState } from 'react'
import type { LayoutNode, LayoutResult } from './layout.ts'

/** 淡出窗口时长（与 CSS 的 dag-leave keyframes 同步）。 */
export const LEAVE_MS = 400
/** 入场动画时长（与 CSS 的 dag-pop keyframes 同步；结束后摘掉 entering 类）。 */
export const ENTER_MS = 450

/** 键集 diff（纯函数）：新增键与消失键。 */
export function diffNodeKeys(prev: ReadonlySet<string>, next: ReadonlySet<string>): {
  added: string[]
  removed: string[]
} {
  const added: string[] = []
  const removed: string[] = []
  for (const key of next) if (!prev.has(key)) added.push(key)
  for (const key of prev) if (!next.has(key)) removed.push(key)
  return { added, removed }
}

/** 进出场动画状态：entering 键集 + leaving 节点（含其最后布局，渲染灰化残影用）。 */
export interface NodeTransitions {
  entering: ReadonlySet<string>
  leaving: ReadonlyMap<string, LayoutNode>
}

/**
 * 跟踪布局节点集合的增删，产出进出场合拍状态。
 * 新增节点带 ENTER_MS 的 pop-in 类窗口；消失节点保留 LEAVE_MS 的残影后移除。
 * 计时器只在卸载时统一清理；布局抖动期间重叠窗口各自自然到期。
 * @param layout 当前有效布局
 * @returns 进出场状态（render 层只读）
 */
export function useNodeTransitions(layout: LayoutResult): NodeTransitions {
  const prev = useRef<LayoutResult | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<ReadonlyMap<string, LayoutNode>>(new Map())

  useEffect(() => {
    const before = prev.current
    prev.current = layout
    if (before === null || before === layout) return
    const { added, removed } = diffNodeKeys(new Set(before.nodes.keys()), new Set(layout.nodes.keys()))
    if (added.length > 0) {
      setEntering(new Set(added))
      const timer = setTimeout(() => setEntering(new Set()), ENTER_MS)
      timers.current.push(timer)
    }
    if (removed.length > 0) {
      const ghosts = new Map<string, LayoutNode>()
      for (const key of removed) {
        const node = before.nodes.get(key)
        if (node !== undefined) ghosts.set(key, node)
      }
      if (ghosts.size > 0) {
        setLeaving((cur) => new Map([...cur, ...ghosts]))
        const timer = setTimeout(() => {
          setLeaving((cur) => {
            const next = new Map(cur)
            for (const key of ghosts.keys()) next.delete(key)
            return next
          })
        }, LEAVE_MS)
        timers.current.push(timer)
      }
    }
  }, [layout])

  useEffect(() => {
    const owned = timers.current
    return () => {
      for (const timer of owned) clearTimeout(timer)
    }
  }, [])

  return { entering, leaving }
}

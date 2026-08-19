/**
 * 事件 ticker 层（设计 v0.5 §7）：记录最近 20 条状态流转。
 * 新事件顶部滑入；点击条目 → 焦点跳到该插件 + 镜头飞行。
 * 它是"视口外事件"的持久记录，也是手动焦点的一个入口。
 * @module dsh-fiber-lens/client/dag/ticker
 */
import type { StateChange } from './diff.ts'

/** 一条 ticker 事件。 */
export interface TickerEvent {
  uid: string
  name: string
  fromState: string
  toState: string
  at: number
}

/** ticker 容量（设计 v0.5 §7：最近 20 条）。 */
export const TICKER_CAPACITY = 20

/** 从 stateChanges 生成 ticker 事件列表。 */
export function changesToEvents(changes: StateChange[]): TickerEvent[] {
  const now = Date.now()
  return changes.map((change) => ({
    uid: change.uid,
    name: change.name,
    fromState: change.from,
    toState: change.to,
    at: now,
  }))
}

/** ticker 缓冲区：固定容量，新事件 unshift 到头部。 */
export class TickerBuffer {
  private events: TickerEvent[] = []

  /** 推入一批事件（合并到头部，超出容量截断尾部）。 */
  push(events: TickerEvent[]): void {
    this.events = [...events, ...this.events].slice(0, TICKER_CAPACITY)
  }

  /** 获取当前事件列表（新→旧）。 */
  list(): readonly TickerEvent[] {
    return this.events
  }

  /** 清空。 */
  clear(): void {
    this.events = []
  }

  /** 事件数量。 */
  get size(): number {
    return this.events.length
  }
}

/** 格式化 ticker 事件为显示文本（设计 v0.5 §7 格式）。 */
export function formatTickerEvent(event: TickerEvent): string {
  const time = new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })
  return `${event.name} ${event.fromState}→${event.toState} ${time}`
}

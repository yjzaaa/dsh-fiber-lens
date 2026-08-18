/**
 * Fiber Lens 浏览器侧 store：手写极简订阅实现，零额外依赖。
 * 快照 + 面板开合状态 + 连通性，全部叶子标量/自有 JSON。
 * @module dsh-fiber-lens/client/store
 */
import { useSyncExternalStore } from 'react'

/** 与 Host 侧同构的快照类型（线协议即 JSON，客户端自持一份）。 */
export interface FiberNode {
  uid: string | null
  name: string
  state: string
  depth: number
  parentUid: string | null
  inject: string[]
  missing: string[]
  provides: string[]
}

export interface ServiceRow {
  name: string
  ownerUid: string | null
  ownerName: string
  ownerState: string
}

/** 同名 fiber 的分组聚合行（Host 计算）：264 个实例 → 百余个逻辑插件。 */
export interface FiberGroup {
  name: string
  kind: 'internal' | 'plugin'
  count: number
  states: Record<string, number>
  worst: string
  provides: string[]
  missing: string[]
}

export interface LensSnapshot {
  version: number
  at: number
  fibers: FiberNode[]
  services: ServiceRow[]
  groups: FiberGroup[]
}

/** 面板镜头：机制镜头（全量 fiber 树）/ 会话镜头（当前会话参与集）。 */
export type LensKind = 'mechanism' | 'session'

/** 一条在飞调用（与 Host 侧同构的线上协议）。 */
export interface InflightEntry {
  callId: string
  fiberName: string
  toolName: string
  argsSummary: string
  gate: string
}

/** 参与查询结果（与 Host 侧同构）。 */
export interface ParticipationSnapshot {
  session: string | null
  participants: string[]
  inflight: InflightEntry[]
}

export interface LensState {
  open: boolean
  version: number
  snapshot: LensSnapshot | null
  reachable: boolean
  error: string | null
  /** 当前镜头；轮询循环需要它决定是否拉参与集，故进 store。 */
  lens: LensKind
  /** 用户是否显式切过镜头（默认镜头规则只生效一次：有会话时会话镜头）。 */
  lensTouched: boolean
  /** 当前会话 id（来自宿主 useSessions 全局标准件）；无当前会话为 null。 */
  sessionId: string | null
  /** 会话镜头的参与数据；lens !== 'session' 或无当前会话时为 null。 */
  participation: ParticipationSnapshot | null
}

export interface FiberLensStore {
  get(): LensState
  patch(partial: Partial<LensState>): void
  subscribe(listener: () => void): () => void
}

export function createFiberLensStore(): FiberLensStore {
  let state: LensState = {
    open: false,
    version: -1,
    snapshot: null,
    reachable: true,
    error: null,
    lens: 'mechanism',
    lensTouched: false,
    sessionId: null,
    participation: null,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    patch(partial) {
      state = { ...state, ...partial }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** React 绑定。 */
export function useFiberLensStore(store: FiberLensStore): LensState {
  return useSyncExternalStore(store.subscribe, store.get)
}

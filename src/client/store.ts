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

export interface LensState {
  open: boolean
  version: number
  snapshot: LensSnapshot | null
  reachable: boolean
  error: string | null
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

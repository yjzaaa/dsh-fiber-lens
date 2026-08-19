/**
 * 快照 diff 层（管线的 diff 段，纯函数）。
 * 对比新旧 LensSnapshot，输出键增删 + uid→state 变化。
 * 300ms 合并窗口：连续 diff 合并为一批动画，防止高频事件闪屏。
 * @module dsh-fiber-lens/client/dag/diff
 */
import type { FiberNode, LensSnapshot } from '../store.ts'

/** 单个 fiber 的状态变化记录。 */
export interface StateChange {
  uid: string
  name: string
  from: string
  to: string
}

/** 一次快照 diff 的结果。 */
export interface SnapshotDiff {
  /** 新增 fiber uid 列表。 */
  added: string[]
  /** 消失 fiber uid 列表。 */
  removed: string[]
  /** 状态变化的 fiber 列表。 */
  stateChanges: StateChange[]
  /** 合并窗口内累计的原始 diff 批次数。 */
  batchCount: number
  /** 生成时间戳。 */
  at: number
}

/** 合并窗口时长（设计 v0.5 §5.3：300ms）。 */
export const MERGE_WINDOW_MS = 300

/** 空 diff。 */
const EMPTY_DIFF: SnapshotDiff = {
  added: [],
  removed: [],
  stateChanges: [],
  batchCount: 0,
  at: 0,
}

/** 对比两个快照，输出结构化 diff。 */
export function diffSnapshots(
  prev: LensSnapshot | null,
  next: LensSnapshot,
): SnapshotDiff {
  if (prev === null) {
    return {
      added: next.fibers.map((f) => f.uid).filter((uid): uid is string => uid !== null),
      removed: [],
      stateChanges: [],
      batchCount: 1,
      at: Date.now(),
    }
  }

  const prevByUid = new Map<string, FiberNode>()
  for (const fiber of prev.fibers) {
    if (fiber.uid !== null) prevByUid.set(fiber.uid, fiber)
  }

  const nextByUid = new Map<string, FiberNode>()
  for (const fiber of next.fibers) {
    if (fiber.uid !== null) nextByUid.set(fiber.uid, fiber)
  }

  const added: string[] = []
  const removed: string[] = []
  const stateChanges: StateChange[] = []

  // 找新增和状态变化
  for (const [uid, fiber] of nextByUid) {
    const prevFiber = prevByUid.get(uid)
    if (prevFiber === undefined) {
      added.push(uid)
    } else if (prevFiber.state !== fiber.state) {
      stateChanges.push({
        uid,
        name: fiber.name,
        from: prevFiber.state,
        to: fiber.state,
      })
    }
  }

  // 找消失
  for (const uid of prevByUid.keys()) {
    if (!nextByUid.has(uid)) {
      removed.push(uid)
    }
  }

  return {
    added,
    removed,
    stateChanges,
    batchCount: 1,
    at: Date.now(),
  }
}

/** 合并两个 diff（用于 300ms 合并窗口）。 */
export function mergeDiffs(a: SnapshotDiff, b: SnapshotDiff): SnapshotDiff {
  // added: a.added + b.added - a.removed（b 中新增的如果在 a 中已删则不算）
  const addedSet = new Set([...a.added, ...b.added])
  for (const uid of a.removed) addedSet.delete(uid)

  // removed: a.removed + b.removed - b.added（b 中删的如果在 a 中已加则不算）
  const removedSet = new Set([...a.removed, ...b.removed])
  for (const uid of b.added) removedSet.delete(uid)

  // stateChanges: 按 uid 合并，取最新的 from→to
  const changeMap = new Map<string, StateChange>()
  for (const change of a.stateChanges) changeMap.set(change.uid, change)
  for (const change of b.stateChanges) {
    const existing = changeMap.get(change.uid)
    if (existing !== undefined) {
      // 连续变化：保留最早的 from，最新的 to
      changeMap.set(change.uid, {
        uid: change.uid,
        name: change.name,
        from: existing.from,
        to: change.to,
      })
    } else {
      changeMap.set(change.uid, change)
    }
  }

  // 过滤掉 from === to 的（合并后回到原状态）
  const stateChanges = [...changeMap.values()].filter((c) => c.from !== c.to)

  return {
    added: [...addedSet],
    removed: [...removedSet],
    stateChanges,
    batchCount: a.batchCount + b.batchCount,
    at: Date.now(),
  }
}

/** 判断 diff 是否为空（无实质变化）。 */
export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.stateChanges.length === 0
}

/** 判断 diff 是否在合并窗口内。 */
export function withinMergeWindow(diff: SnapshotDiff, now: number): boolean {
  return now - diff.at < MERGE_WINDOW_MS
}

/** 创建空 diff。 */
export function emptyDiff(): SnapshotDiff {
  return { ...EMPTY_DIFF, at: Date.now() }
}

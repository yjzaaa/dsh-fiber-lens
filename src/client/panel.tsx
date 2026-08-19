/**
 * Fiber Lens 浮层面板：⛓ 焦点链（默认主视图）+ ☰ 分组列表（找插件入口）。
 * 列表实例行点击 → 跳到焦点链并聚焦该 fiber；
 * 未手动聚焦时默认聚焦 agent-loop（不存在则第一个 active 业务插件）。
 * 焦点策略（设计 v0.5 §3.3）：默认自动跟随最近状态流转；点击接管手动焦点；
 * Esc 或 3s 无操作恢复自动；焦点切换 1.5s 滞回。
 * @module dsh-fiber-lens/client/panel
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FiberGroup, FiberNode, LensState } from './store.ts'
import { FocusCanvas } from './dag/focus-canvas.tsx'
import { diffSnapshots, mergeDiffs, isEmptyDiff, MERGE_WINDOW_MS, type SnapshotDiff } from './dag/diff.ts'
import { TickerBuffer, changesToEvents, formatTickerEvent } from './dag/ticker.ts'
import {
  applyPending,
  autoFollow,
  clearFocus,
  initFocusState,
  resumeAuto,
  selectDefault,
  takeOver,
  touch,
  MIN_DWELL_MS,
  type FocusState,
} from './dag/focus.ts'
import styles from './fiber-lens.module.css'

const STATE_ICONS: Record<string, string> = {
  active: '●',
  pending: '◌',
  loading: '◔',
  unloading: '◍',
  failed: '✕',
  disposed: '○',
}

/** Cordis Loader 机制 fiber 名（与 Host 侧 INTERNAL_NAMES 一致）。 */
const INTERNAL_NAMES = new Set(['Loader', 'Hmr', 'Include', 'isolate', 'Group', 'scope'])

function StateDot({ state }: { state: string }) {
  return <span className={`${styles.dot} ${styles[`state-${state}`] ?? ''}`}>{STATE_ICONS[state] ?? '?'}</span>
}

/** 实例行（组展开后的最小单元；点击 = 聚焦到焦点链）。 */
function FiberRow({ fiber, selected, onFocus }: {
  fiber: FiberNode
  selected: boolean
  onFocus: (uid: string) => void
}) {
  return (
    <div
      className={`${styles.row} ${styles.instanceRow} ${selected ? styles.rowSelected : ''}`}
      title="点击聚焦上下游链"
      onClick={() => {
        if (fiber.uid !== null) onFocus(fiber.uid)
      }}
    >
      <StateDot state={fiber.state} />
      <span className={styles.instanceMeta}>uid {fiber.uid ?? '?'} · depth {fiber.depth}</span>
      <span className={styles.stateLabel}>{fiber.state}</span>
      {fiber.missing.length > 0 && <span className={styles.waiting}>⚠ {fiber.missing.join(', ')}</span>}
      {fiber.provides.length > 0 && <span className={styles.provides}>▸ {fiber.provides.join(', ')}</span>}
    </div>
  )
}

/** 分组行：逻辑插件 + 实例数 + 展开实例列表。 */
function GroupRow({ group, fibers, expanded, onToggle, focusedUid, onFocus }: {
  group: FiberGroup
  fibers: FiberNode[]
  expanded: boolean
  onToggle: () => void
  focusedUid: string | null
  onFocus: (uid: string) => void
}) {
  return (
    <div>
      <div className={`${styles.row} ${styles.groupRow}`} onClick={onToggle}>
        <span className={styles.caret}>{expanded ? '▾' : '▸'}</span>
        <StateDot state={group.worst} />
        <span className={styles.fiberName}>{group.name}</span>
        {group.count > 1 && <span className={styles.countBadge}>×{group.count}</span>}
        <span className={styles.stateLabel}>{group.worst}</span>
        {group.missing.length > 0 && <span className={styles.waiting}>⚠ {group.missing.join(', ')}</span>}
        {group.provides.length > 0 && <span className={styles.provides}>▸ {group.provides.join(', ')}</span>}
      </div>
      {expanded && fibers.map((fiber, index) => (
        <FiberRow
          key={fiber.uid ?? `${fiber.name}:${index}`}
          fiber={fiber}
          selected={focusedUid !== null && fiber.uid === focusedUid}
          onFocus={onFocus}
        />
      ))}
    </div>
  )
}

/** 折叠偏好持久化键（设计 v0.5 §4.4：折叠偏好可入 localStorage，跨重启存活）。 */
const PREFS_KEY = 'fiber-lens:prefs'

/** 可持久化的面板偏好：分组展开/折叠 + 内部机制区开关。 */
interface PanelPrefs {
  expanded: Record<string, boolean>
  showInternal: boolean
}

/** 读取折叠偏好；任何异常（隐私模式 / JSON 损坏 / 非浏览器环境）都回退默认。 */
function loadPrefs(): PanelPrefs {
  const fallback: PanelPrefs = { expanded: {}, showInternal: false }
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY)
    if (raw === null || raw === undefined) return fallback
    const parsed = JSON.parse(raw) as Partial<PanelPrefs>
    return {
      expanded: typeof parsed.expanded === 'object' && parsed.expanded !== null ? parsed.expanded : {},
      showInternal: parsed.showInternal === true,
    }
  } catch {
    return fallback
  }
}

/** 写入折叠偏好；失败静默（配额 / 隐私模式）。 */
function savePrefs(prefs: PanelPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* 静默 */
  }
}

export function LensPanel({ state, onClose }: { state: LensState; onClose: () => void }) {
  // 焦点链为默认主视图；列表是"找插件"的入口视图。
  const [view, setView] = useState<'chain' | 'list'>('chain')
  // 焦点解析状态机（设计 §3.3，管线的 focus 段）：auto = 自动跟随 / manual = 用户接管 + 滞回。
  const [focus, setFocus] = useState<FocusState>(() => initFocusState())
  const focusUid = focus.uid
  // §4.4 折叠偏好：初始值来自 localStorage（跨重启存活），变更即回写。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => loadPrefs().expanded)
  const [showInternal, setShowInternal] = useState<boolean>(() => loadPrefs().showInternal)
  const snapshot = state.snapshot

  // ===== diff + ticker 状态（P2 动画纪律）=====
  const [pendingDiff, setPendingDiff] = useState<SnapshotDiff | null>(null)
  const [tickerEvents, setTickerEvents] = useState<readonly import('./dag/ticker.ts').TickerEvent[]>([])
  const prevSnapshotRef = useRef<typeof snapshot>(null)
  const tickerBufferRef = useRef(new TickerBuffer())
  const mergeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // diff 管线（设计 v0.5 §5.3 合并窗口 + §5.4 状态 diff + §7 ticker）：
  // 快照变化 → diffSnapshots；stateChanges 进 ticker 缓冲（最近 20 条）；
  // diff 在 300ms 合并窗口内累计，窗口结束批量下发 FocusCanvas 驱动动画。
  const pendingRef = useRef<SnapshotDiff | null>(null)
  useEffect(() => {
    const prev = prevSnapshotRef.current
    prevSnapshotRef.current = snapshot
    if (snapshot === null) return
    const diff = diffSnapshots(prev, snapshot)
    if (isEmptyDiff(diff)) return
    if (diff.stateChanges.length > 0) {
      tickerBufferRef.current.push(changesToEvents(diff.stateChanges))
      setTickerEvents(tickerBufferRef.current.list())
    }
    // 自动跟随信号（§3.3）：最近状态流转的插件成为焦点；新增 fiber 视为 ∅→state 流转。
    // 手动模式未空闲超时 / 滞回窗口内时由 focus 状态机内部推迟或忽略。
    const candidate = diff.stateChanges.at(-1)?.uid ?? diff.added.at(-1)
    if (candidate !== undefined && snapshot.fibers.some((f) => f.uid === candidate)) {
      setFocus((cur) => autoFollow(cur, candidate, Date.now()))
    }
    pendingRef.current = pendingRef.current === null ? diff : mergeDiffs(pendingRef.current, diff)
    if (mergeTimerRef.current !== null) return
    mergeTimerRef.current = setTimeout(() => {
      mergeTimerRef.current = null
      const merged = pendingRef.current
      pendingRef.current = null
      if (merged !== null) setPendingDiff(merged)
    }, MERGE_WINDOW_MS)
  }, [snapshot])

  // 滞回延迟切换（§3.3）：dwell 满后应用被推迟的自动跟随候选；候选已消失则丢弃。
  useEffect(() => {
    if (focus.pendingUid === null) return
    const remaining = Math.max(0, MIN_DWELL_MS - (Date.now() - focus.lastSwitchAt))
    const timer = setTimeout(() => {
      setFocus((cur) => {
        const pending = cur.pendingUid
        const snap = prevSnapshotRef.current
        if (pending !== null && snap !== null && !snap.fibers.some((f) => f.uid === pending)) {
          return { ...cur, pendingUid: null }
        }
        return applyPending(cur, Date.now())
      })
    }, remaining)
    return () => clearTimeout(timer)
  }, [focus.pendingUid, focus.lastSwitchAt])

  // Esc 恢复自动跟随（§3.3）；面板隐藏时不挂监听。
  useEffect(() => {
    if (!state.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocus((cur) => resumeAuto(cur))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.open])

  useEffect(() => {
    savePrefs({ expanded: expandedGroups, showInternal })
  }, [expandedGroups, showInternal])

  // 默认焦点：agent-loop 优先，否则第一个 active 业务插件实例。
  useEffect(() => {
    if (focusUid !== null || snapshot === null) return
    const fibers = snapshot.fibers.filter((f) => f.uid !== null && !INTERNAL_NAMES.has(f.name))
    const preferred = fibers.find((f) => f.name === 'agent-loop' && f.state === 'active')
      ?? fibers.find((f) => f.state === 'active')
      ?? fibers[0]
    if (preferred !== undefined && preferred.uid !== null) {
      const uid = preferred.uid
      setFocus((cur) => selectDefault(cur, uid, Date.now()))
    }
  }, [snapshot, focusUid])

  // 焦点 fiber 从快照中消失（被卸载）→ 清除焦点，等待默认规则重选。
  useEffect(() => {
    if (focusUid === null || snapshot === null) return
    if (!snapshot.fibers.some((f) => f.uid === focusUid)) {
      setFocus((cur) => clearFocus(cur, Date.now()))
    }
  }, [snapshot, focusUid])

  // 面板拖拽：null = 默认居中；拖过以后用 inline left/top 自由定位。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button') !== null) return
    const panel = e.currentTarget.parentElement
    if (panel === null) return
    const rect = panel.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d === null) return
    setPos({ x: d.baseX + e.clientX - d.startX, y: d.baseY + e.clientY - d.startY })
  }
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const focusFromList = (uid: string): void => {
    setFocus((cur) => takeOver(cur, uid, Date.now()))
    setView('chain')
  }

  const toggleGroup = (name: string): void =>
    setExpandedGroups((cur) => ({ ...cur, [name]: !cur[name] }))

  const groups = snapshot?.groups ?? []
  const pluginGroups = groups.filter((g) => g.kind === 'plugin')
  const internalGroups = groups.filter((g) => g.kind === 'internal')
  const internalCount = internalGroups.reduce((sum, g) => sum + g.count, 0)

  const fibersOf = (name: string): FiberNode[] =>
    (snapshot?.fibers ?? []).filter((f) => f.name === name)

  const focusedFiber = snapshot?.fibers.find((f) => f.uid !== null && f.uid === focusUid) ?? null
  const abnormal = groups.filter((g) => g.worst !== 'active').length

  // createPortal 挂到 document.body：彻底跳出 slot 单元格的层叠上下文。
  // 关闭时仅 display:none 隐藏（不卸载组件树），保持视口 transform 状态。
  return createPortal(
    <div className={`${styles.overlayRoot} ${state.open ? '' : styles.panelHidden}`}>
      <div
        className={`${styles.panel} ${view === 'chain' ? styles.panelDag : ''} ${pos !== null ? styles.panelDragged : ''}`}
        style={pos !== null ? { left: pos.x, top: pos.y } : undefined}
      >
        <div
          className={styles.header}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
        >
          <span className={styles.title}>🔬 Fiber Lens</span>
          <span className={styles.stats}>
            {snapshot === null
              ? 'loading…'
              : `${groups.length} 插件 · ${snapshot.fibers.length} 实例${abnormal > 0 ? ` · ${abnormal} 异常` : ''}`}
          </span>
          <button
            type="button"
            className={`${styles.viewBtn} ${view === 'chain' ? styles.viewBtnActive : ''}`}
            onClick={() => setView('chain')}
          >⛓ 焦点链</button>
          <button
            type="button"
            className={`${styles.viewBtn} ${view === 'list' ? styles.viewBtnActive : ''}`}
            onClick={() => setView('list')}
          >☰ 列表</button>
          <span className={state.reachable ? styles.ok : styles.waiting}>
            {state.reachable ? `v${state.version}` : '离线'}
          </span>
          <button type="button" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        {state.error !== null && <div className={styles.errorBar}>{state.error}</div>}
        {view === 'chain' ? (
          <div className={styles.bodyDag}>
            {snapshot === null
              ? <div className={styles.empty}>等待首个快照…</div>
              : (
                <>
                  <FocusCanvas
                    fibers={snapshot.fibers}
                    services={snapshot.services}
                    activities={snapshot.activities}
                    focusUid={focusUid}
                    onFocus={(uid) => setFocus((cur) => takeOver(cur, uid, Date.now()))}
                    followMode={focus.mode}
                    onActivity={() => setFocus((cur) => touch(cur, Date.now()))}
                    diff={pendingDiff}
                  />
                  {/* 事件 ticker（§7）：右侧 180px，最近 20 条状态流转，新事件顶部滑入；点击聚焦跳转 */}
                  <div className={styles.tickerCol}>
                    <div className={styles.tickerTitle}>事件 ticker</div>
                    {tickerEvents.length === 0
                      ? <div className={styles.tickerEmpty}>暂无状态流转</div>
                      : tickerEvents.map((ev) => (
                        <div
                          key={`${ev.uid}:${ev.at}:${ev.fromState}>${ev.toState}`}
                          className={styles.tickerItem}
                          title="点击聚焦该插件（接管为手动焦点，镜头飞行跳转）"
                          onClick={() => setFocus((cur) => takeOver(cur, ev.uid, Date.now()))}
                        >{formatTickerEvent(ev)}</div>
                      ))}
                  </div>
                </>
              )}
          </div>
        ) : (
          <div className={styles.body}>
            {snapshot === null && <div className={styles.empty}>等待首个快照…</div>}
            {pluginGroups.map((group) => (
              <GroupRow
                key={group.name}
                group={group}
                fibers={expandedGroups[group.name] === true ? fibersOf(group.name) : []}
                expanded={expandedGroups[group.name] === true}
                onToggle={() => toggleGroup(group.name)}
                focusedUid={focusUid}
                onFocus={focusFromList}
              />
            ))}
            {internalGroups.length > 0 && (
              <div>
                <div className={`${styles.row} ${styles.internalHeader}`} onClick={() => setShowInternal((cur) => !cur)}>
                  <span className={styles.caret}>{showInternal ? '▾' : '▸'}</span>
                  <span className={styles.instanceMeta}>⚙ 运行时机制（Cordis Loader 内部 fiber ×{internalCount}）</span>
                </div>
                {showInternal && internalGroups.map((group) => (
                  <GroupRow
                    key={group.name}
                    group={group}
                    fibers={expandedGroups[group.name] === true ? fibersOf(group.name) : []}
                    expanded={expandedGroups[group.name] === true}
                    onToggle={() => toggleGroup(group.name)}
                    focusedUid={focusUid}
                    onFocus={focusFromList}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        <div className={styles.footer}>
          {snapshot !== null && (
            view === 'chain' && focusedFiber !== null
              ? `焦点: ${focusedFiber.name} (uid ${focusedFiber.uid}) · ${focus.mode === 'auto' ? '自动跟随' : '手动焦点'} · 快照 v${snapshot.version} · ${new Date(snapshot.at).toLocaleTimeString()}`
              : `快照 v${snapshot.version} · ${new Date(snapshot.at).toLocaleTimeString()} · ${snapshot.services.length} 个服务`
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

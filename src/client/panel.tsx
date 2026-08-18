/**
 * Fiber Lens 浮层面板：分组视图（逻辑插件 ×N 实例）+ 实例展开 + 详情卡。
 * 264 个 fiber 实例按名称聚合为百余个逻辑插件；Cordis 机制 fiber
 * （Loader/Hmr/Include/isolate…）单独折叠在底部「运行时机制」区。
 * @module dsh-fiber-lens/client/panel
 */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FiberGroup, FiberLensStore, FiberNode, LensState } from './store.ts'
import { DagCanvas } from './dag/canvas.tsx'
import { SessionCanvas } from './dag/session-canvas.tsx'
import styles from './fiber-lens.module.css'

const STATE_ICONS: Record<string, string> = {
  active: '●',
  pending: '◌',
  loading: '◔',
  unloading: '◍',
  failed: '✕',
  disposed: '○',
}

function StateDot({ state }: { state: string }) {
  return <span className={`${styles.dot} ${styles[`state-${state}`] ?? ''}`}>{STATE_ICONS[state] ?? '?'}</span>
}

/** 实例行（组展开后的最小单元）。 */
function FiberRow({ fiber, selected, onSelect }: {
  fiber: FiberNode
  selected: boolean
  onSelect: (uid: string | null) => void
}) {
  return (
    <div
      className={`${styles.row} ${styles.instanceRow} ${selected ? styles.rowSelected : ''}`}
      onClick={() => onSelect(fiber.uid)}
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
function GroupRow({ group, fibers, expanded, onToggle, selectedUid, onSelect }: {
  group: FiberGroup
  fibers: FiberNode[]
  expanded: boolean
  onToggle: () => void
  selectedUid: string | null
  onSelect: (uid: string | null) => void
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
          selected={selectedUid !== null && fiber.uid === selectedUid}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function FiberDetail({ fiber }: { fiber: FiberNode }) {
  return (
    <div className={styles.detail}>
      <div><b>{fiber.name}</b> <span className={styles.stateLabel}>{fiber.state}</span></div>
      <div className={styles.detailLine}>uid: {fiber.uid ?? '(n/a)'} · depth: {fiber.depth} · parent: {fiber.parentUid ?? '(root)'}</div>
      {fiber.inject.length > 0 && (
        <div className={styles.detailLine}>
          inject: {fiber.inject.map((key) => (
            <span key={key} className={fiber.missing.includes(key) ? styles.waiting : styles.ok}>
              {fiber.missing.includes(key) ? '✗' : '✓'}{key}{' '}
            </span>
          ))}
        </div>
      )}
      {fiber.provides.length > 0 && (
        <div className={styles.detailLine}>provides: {fiber.provides.join(', ')}</div>
      )}
    </div>
  )
}

export function LensPanel({ state, store, onClose }: { state: LensState; store: FiberLensStore; onClose: () => void }) {
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [showInternal, setShowInternal] = useState(false)
  // 列表 / DAG 视图切换：面板本地状态，不持久化；镜头（机制/会话）在 store（轮询需要）。
  const [view, setView] = useState<'list' | 'dag'>('list')
  const lens = state.lens
  const snapshot = state.snapshot

  // 面板拖拽：null = 默认居中；拖过以后用 inline left/top 自由定位（面板本地状态，不持久化）。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 点在按钮（视图切换/关闭）上不启动拖拽
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

  const toggleGroup = (name: string): void =>
    setExpandedGroups((cur) => ({ ...cur, [name]: !cur[name] }))

  const showList = (): void => setView('list')
  const showLens = (next: 'mechanism' | 'session'): void => {
    setView('dag')
    store.patch({ lens: next, lensTouched: true })
  }

  const groups = snapshot?.groups ?? []
  const pluginGroups = groups.filter((g) => g.kind === 'plugin')
  const internalGroups = groups.filter((g) => g.kind === 'internal')
  const internalCount = internalGroups.reduce((sum, g) => sum + g.count, 0)

  const fibersOf = (name: string): FiberNode[] =>
    (snapshot?.fibers ?? []).filter((f) => f.name === name)

  const selected = snapshot?.fibers.find((f) => f.uid !== null && f.uid === selectedUid) ?? null
  const abnormal = groups.filter((g) => g.worst !== 'active').length

  // createPortal 挂到 document.body：彻底跳出 slot 单元格的层叠上下文。
  return createPortal(
    <div className={styles.overlayRoot}>
      <div
        className={`${styles.panel} ${view === 'dag' ? styles.panelDag : ''} ${pos !== null ? styles.panelDragged : ''}`}
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
            className={`${styles.viewBtn} ${view === 'list' ? styles.viewBtnActive : ''}`}
            onClick={showList}
          >☰ 列表</button>
          <button
            type="button"
            className={`${styles.viewBtn} ${view === 'dag' && lens === 'mechanism' ? styles.viewBtnActive : ''}`}
            onClick={() => showLens('mechanism')}
          >🔬 机制</button>
          <button
            type="button"
            className={`${styles.viewBtn} ${view === 'dag' && lens === 'session' ? styles.viewBtnActive : ''}`}
            onClick={() => showLens('session')}
          >💬 会话</button>
          <span className={state.reachable ? styles.ok : styles.waiting}>
            {state.reachable ? `v${state.version}` : '离线'}
          </span>
          <button type="button" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        {state.error !== null && <div className={styles.errorBar}>{state.error}</div>}
        {view === 'dag' ? (
          <div className={styles.bodyDag}>
            {snapshot === null
              ? <div className={styles.empty}>等待首个快照…</div>
              : lens === 'session'
                ? (
                  <SessionCanvas
                    fibers={snapshot.fibers}
                    participation={state.participation}
                    sessionId={state.sessionId}
                  />
                )
                : (
                  <DagCanvas
                    fibers={snapshot.fibers}
                    selectedUid={selectedUid}
                    onSelect={(uid) => setSelectedUid((cur) => (cur === uid ? null : uid))}
                  />
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
              selectedUid={selectedUid}
              onSelect={(uid) => setSelectedUid((cur) => (cur === uid ? null : uid))}
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
                  selectedUid={selectedUid}
                  onSelect={(uid) => setSelectedUid((cur) => (cur === uid ? null : uid))}
                />
              ))}
            </div>
          )}
        </div>
        )}
        {selected !== null && <FiberDetail fiber={selected} />}
        <div className={styles.footer}>
          {snapshot !== null && `快照 v${snapshot.version} · ${new Date(snapshot.at).toLocaleTimeString()} · ${snapshot.services.length} 个服务`}
        </div>
      </div>
    </div>,
    document.body,
  )
}

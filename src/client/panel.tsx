/**
 * Fiber Lens 浮层面板：缩进树 + 状态灯 + inject/provides 行内标注。
 * 点击某行展开详情（missing 依赖高亮）。
 * @module dsh-fiber-lens/client/panel
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { FiberNode, LensState } from './store.ts'
import styles from './fiber-lens.module.css'

const STATE_ICONS: Record<string, string> = {
  active: '●',
  pending: '◌',
  loading: '◔',
  unloading: '◍',
  failed: '✕',
  disposed: '○',
}

function FiberRow({ fiber, selected, onSelect }: {
  fiber: FiberNode
  selected: boolean
  onSelect: (uid: string | null) => void
}) {
  const icon = STATE_ICONS[fiber.state] ?? '?'
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      style={{ paddingLeft: `${10 + fiber.depth * 16}px` }}
      onClick={() => onSelect(fiber.uid)}
    >
      <span className={`${styles.dot} ${styles[`state-${fiber.state}`] ?? ''}`}>{icon}</span>
      <span className={styles.fiberName}>{fiber.name}</span>
      <span className={styles.stateLabel}>{fiber.state}</span>
      {fiber.missing.length > 0 && (
        <span className={styles.waiting}>⚠ {fiber.missing.join(', ')}</span>
      )}
      {fiber.provides.length > 0 && (
        <span className={styles.provides}>▸ {fiber.provides.join(', ')}</span>
      )}
    </div>
  )
}

function FiberDetail({ fiber }: { fiber: FiberNode }) {
  return (
    <div className={styles.detail}>
      <div><b>{fiber.name}</b> <span className={styles.stateLabel}>{fiber.state}</span></div>
      <div className={styles.detailLine}>uid: {fiber.uid ?? '(n/a)'}</div>
      <div className={styles.detailLine}>depth: {fiber.depth} · parent: {fiber.parentUid ?? '(root)'}</div>
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

export function LensPanel({ state, onClose }: { state: LensState; onClose: () => void }) {
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const snapshot = state.snapshot
  const selected = snapshot?.fibers.find((f) => f.uid !== null && f.uid === selectedUid) ?? null

  const counts = { active: 0, pending: 0, failed: 0, other: 0 }
  if (snapshot !== null) {
    for (const f of snapshot.fibers) {
      if (f.state === 'active') counts.active++
      else if (f.state === 'pending') counts.pending++
      else if (f.state === 'failed') counts.failed++
      else counts.other++
    }
  }

  // createPortal 挂到 document.body：彻底跳出 slot 单元格的层叠上下文，
  // z-index 99999 直接在根层叠上下文竞争，任何祖先 transform/filter 都压不住。
  return createPortal(
    <div className={styles.overlayRoot}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>🔬 Fiber Lens</span>
          <span className={styles.stats}>
            {snapshot === null
              ? 'loading…'
              : `${counts.active} active · ${counts.pending} pending · ${counts.failed} failed`}
          </span>
          <span className={state.reachable ? styles.ok : styles.waiting}>
            {state.reachable ? `v${state.version}` : '离线'}
          </span>
          <button type="button" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        {state.error !== null && <div className={styles.errorBar}>{state.error}</div>}
        <div className={styles.body}>
          {snapshot === null && <div className={styles.empty}>等待首个快照…</div>}
          {snapshot !== null && snapshot.fibers.map((fiber, index) => (
            <FiberRow
              key={fiber.uid ?? `${fiber.name}:${index}`}
              fiber={fiber}
              selected={selected !== null && selected.uid === fiber.uid && fiber.uid !== null}
              onSelect={(uid) => setSelectedUid((cur) => (cur === uid ? null : uid))}
            />
          ))}
        </div>
        {selected !== null && <FiberDetail fiber={selected} />}
        <div className={styles.footer}>
          {snapshot !== null && `快照 v${snapshot.version} · ${new Date(snapshot.at).toLocaleTimeString()} · ${snapshot.services.length} 个服务`}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Fiber Lens — 浏览器半身。
 *
 * 两个 Slot 注册：
 *   sidebar.footer.action → 「🔬 Fiber Lens」触发按钮
 *   shell.overlay         → fiber 树浮层面板（点击按钮开合）
 *
 * 数据通路：每 1s fetch /api/fiber-lens/ping 比对 version，
 * 变化才 fetch /api/fiber-lens/snapshot 全量重取（事件驱动 + 轮询外壳）。
 * 会话镜头下同一节拍额外拉 /api/fiber-lens/participation（在飞集合不走 version）。
 *
 * 会话感知：shell.overlay 是 root 作用域 slot，组件 props 携带全局标准件
 * useSessions（runtime 的 GlobalStandardProps 合并），select 出当前会话 id
 * 作为参与查询参数——Host 不猜"当前会话"（设计 v0.4 §8）。
 * @module dsh-fiber-lens/client
 */
import { useEffect } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: slots 服务的 Context 增强 + 目标 Slot 名的声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useFiberLensStore, createFiberLensStore, type FiberLensStore, type ParticipationSnapshot } from './store.ts'
import { LensPanel } from './panel.tsx'
import { TriggerButton } from './trigger.tsx'

/** slots 是硬依赖：没有它本插件没有落点。 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const store: FiberLensStore = createFiberLensStore()

  // 轮询循环：面板打开时才跑，关掉即停（ctx.effect 保证卸载清理）。
  ctx.effect(() => {
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined

    const tick = async (): Promise<void> => {
      const { open, version, lens, sessionId } = store.get()
      if (!open) return
      try {
        const ping = await fetch('/api/fiber-lens/ping').then((r) => r.json()) as { ok: boolean; version?: number }
        if (disposed || !ping.ok || ping.version === undefined) return
        if (ping.version !== version) {
          const snap = await fetch('/api/fiber-lens/snapshot').then((r) => r.json()) as {
            ok: boolean
            snapshot?: import('./store.ts').LensSnapshot
            error?: string
          }
          if (disposed) return
          if (snap.ok && snap.snapshot !== undefined) {
            store.patch({ snapshot: snap.snapshot, version: snap.snapshot.version, reachable: true, error: null })
          } else {
            store.patch({ reachable: true, error: snap.error ?? 'snapshot failed' })
          }
        } else {
          store.patch({ reachable: true })
        }
        // 会话镜头：参与集与在飞集合不驱动 fiber version，每个节拍都拉。
        if (lens === 'session' && store.get().sessionId !== null) {
          const query = encodeURIComponent(store.get().sessionId ?? '')
          const part = await fetch(`/api/fiber-lens/participation?session=${query}`).then((r) => r.json()) as {
            ok: boolean
          } & Partial<ParticipationSnapshot>
          if (disposed) return
          if (part.ok) {
            store.patch({
              participation: {
                session: part.session ?? null,
                participants: part.participants ?? [],
                inflight: part.inflight ?? [],
              },
            })
          }
        }
      } catch (error) {
        if (!disposed) store.patch({ reachable: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // 面板开合状态变化时启动/停止轮询
    const unsubscribe = store.subscribe(() => {
      const open = store.get().open
      if (open && timer === undefined) {
        void tick()
        timer = setInterval(() => void tick(), 1000)
      } else if (!open && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    })

    return () => {
      disposed = true
      unsubscribe()
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'fiber-lens: poll loop')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'fiber-lens-trigger', order: 60, label: 'Fiber Lens' },
      (props) => <TriggerButton store={store} wide={props.wide} />,
    ))

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'fiber-lens-panel', order: 90, label: 'Fiber Lens' },
      (props) => <LensPanelContainer store={store} useSessions={props.useSessions} />,
    ))
}

/** 订阅 store + 全局 useSessions 标准件的容器：把 hooks 留在组件层。 */
function LensPanelContainer({ store, useSessions }: {
  store: FiberLensStore
  useSessions: SnapshotSelectorHook<SessionListState>
}) {
  const state = useFiberLensStore(store)
  const current = useSessions((s) => s.current)

  // 会话切换 → 参与数据作废重拉；首个会话出现时应用默认镜头规则
  // （设计 §11：有当前会话时默认会话镜头，除非用户显式切过）。
  useEffect(() => {
    const prev = store.get().sessionId
    const next = current === undefined ? null : String(current)
    if (prev === next) return
    const { lensTouched } = store.get()
    store.patch({
      sessionId: next,
      participation: null,
      ...(next !== null && !lensTouched ? { lens: 'session' as const } : {}),
    })
  }, [store, current])

  if (!state.open) return null
  return <LensPanel state={state} store={store} onClose={() => store.patch({ open: false })} />
}

/**
 * Fiber Lens — 浏览器半身。
 *
 * 两个 Slot 注册：
 *   sidebar.footer.action → 「🔬 Fiber Lens」触发按钮
 *   shell.overlay         → fiber 树浮层面板（点击按钮开合）
 *
 * 数据通路：每 1s fetch /api/fiber-lens/ping 比对 version，
 * 变化才 fetch /api/fiber-lens/snapshot 全量重取（事件驱动 + 轮询外壳）。
 * @module dsh-fiber-lens/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: slots 服务的 Context 增强 + 目标 Slot 名的声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useFiberLensStore, createFiberLensStore, type FiberLensStore } from './store.ts'
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
      if (!store.get().open) return
      try {
        const ping = await fetch('/api/fiber-lens/ping').then((r) => r.json()) as { ok: boolean; version?: number }
        if (disposed || !ping.ok || ping.version === undefined) return
        if (ping.version === store.get().version) {
          store.patch({ reachable: true })
          return
        }
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
      () => <LensPanelContainer store={store} />,
    ))
}

/** 订阅 store 的容器：把 hooks 留在组件层。 */
function LensPanelContainer({ store }: { store: FiberLensStore }) {
  const state = useFiberLensStore(store)
  if (!state.open) return null
  return <LensPanel state={state} onClose={() => store.patch({ open: false })} />
}

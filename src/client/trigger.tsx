/**
 * 侧边栏底部触发按钮：开合 Fiber Lens 浮层。
 * @module dsh-fiber-lens/client/trigger
 */
import type { FiberLensStore } from './store.ts'
import { useFiberLensStore } from './store.ts'
import styles from './fiber-lens.module.css'

export function TriggerButton({ store, wide = true }: { store: FiberLensStore; wide?: boolean }) {
  const state = useFiberLensStore(store)
  return (
    <button
      type="button"
      className={styles.trigger}
      title={state.open ? '关闭 Fiber Lens' : '打开 Fiber Lens'}
      aria-label="Fiber Lens"
      onClick={() => store.patch({ open: !state.open })}
    >
      🔬{wide ? ' Fiber Lens' : ''}
    </button>
  )
}

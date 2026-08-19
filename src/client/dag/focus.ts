/**
 * 焦点解析层（管线 snapshot → diff → focus → chain → layout 的 focus 段，纯函数）。
 * 设计 v0.5 §3.3：
 * - 默认自动跟随：最近发生状态流转的插件成为焦点（快照 diff 得出）
 * - 点击接管：用户点击任何节点 → 手动焦点，自动跟随暂停
 * - 空闲恢复：Esc 或 3s 无操作恢复自动跟随
 * - 防眩晕滞回：焦点切换最少停留 1.5s；窗口内的新候选记为 pending，dwell 满后切换
 * @module dsh-fiber-lens/client/dag/focus
 */

/** 滞回：焦点切换最少停留时长（设计 §3.3：1.5s）。 */
export const MIN_DWELL_MS = 1500
/** 手动焦点空闲恢复自动跟随的时长（设计 §3.3：3s 无操作）。 */
export const IDLE_RESUME_MS = 3000

/** 焦点解析状态（显式对象，纯函数转换，调用侧持有）。 */
export interface FocusState {
  /** 当前焦点 uid；null = 未选焦点（等待默认规则）。 */
  uid: string | null
  /** auto = 自动跟随中；manual = 用户接管。 */
  mode: 'auto' | 'manual'
  /** 上次焦点切换时间（滞回计时起点，ms epoch）。 */
  lastSwitchAt: number
  /** 上次用户操作时间（空闲恢复计时起点，ms epoch）。 */
  lastUserAt: number
  /** 滞回窗口内被推迟的自动跟随候选（dwell 满后由 applyPending 切换）。 */
  pendingUid: string | null
}

/** 初始状态：自动跟随模式，无焦点。 */
export function initFocusState(): FocusState {
  return { uid: null, mode: 'auto', lastSwitchAt: 0, lastUserAt: 0, pendingUid: null }
}

/** 切换核心：同 uid 只清 pending；dwell 未满时记 pending 推迟切换。 */
const switchTo = (state: FocusState, uid: string, now: number, force: boolean): FocusState => {
  if (state.uid === uid) return { ...state, pendingUid: null }
  if (!force && now - state.lastSwitchAt < MIN_DWELL_MS) {
    return { ...state, pendingUid: uid }
  }
  return { ...state, uid, lastSwitchAt: now, pendingUid: null }
}

/**
 * 自动跟随：最近状态流转的候选 uid。
 * 手动模式且未空闲超时（3s）时不跟随；否则转回 auto 并受滞回约束切换。
 */
export function autoFollow(state: FocusState, candidateUid: string, now: number): FocusState {
  if (state.mode === 'manual' && now - state.lastUserAt < IDLE_RESUME_MS) return state
  return switchTo({ ...state, mode: 'auto' }, candidateUid, now, false)
}

/** 手动接管（点击链上节点 / 列表行 / ticker 条目）：用户意图优先，绕过滞回。 */
export function takeOver(state: FocusState, uid: string, now: number): FocusState {
  const next = switchTo(state, uid, now, true)
  return { ...next, mode: 'manual', lastUserAt: now }
}

/** 用户操作心跳（平移/缩放等）：重置空闲计时，推迟自动恢复。 */
export function touch(state: FocusState, now: number): FocusState {
  return { ...state, lastUserAt: now }
}

/** Esc 恢复自动跟随：立即回到 auto，下一次 diff 候选即可接管（仍受滞回约束）。 */
export function resumeAuto(state: FocusState): FocusState {
  if (state.mode === 'auto') return state
  return { ...state, mode: 'auto' }
}

/** 焦点 fiber 从快照中消失（被卸载）→ 清除焦点，等待默认规则/自动跟随重选。 */
export function clearFocus(state: FocusState, now: number): FocusState {
  if (state.uid === null && state.pendingUid === null) return state
  return { ...state, uid: null, lastSwitchAt: now, pendingUid: null }
}

/** dwell 满后应用滞回候选（由调用侧定时器触发）。 */
export function applyPending(state: FocusState, now: number): FocusState {
  if (state.pendingUid === null) return state
  return switchTo(state, state.pendingUid, now, true)
}

/** 默认焦点选择（首开 / 焦点消失后的兜底）：不受滞回限制，保持 auto 语义。 */
export function selectDefault(state: FocusState, uid: string, now: number): FocusState {
  if (state.uid === uid) return state
  return { ...state, uid, lastSwitchAt: now, pendingUid: null }
}

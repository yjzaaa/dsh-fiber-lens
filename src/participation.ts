/**
 * 会话参与集 + 在飞跟踪（Host 侧，设计 v0.4 §5.2/§5.3）。
 *
 * 数据源：session/created（一次性集合运算推导累积参与集）+
 * session/event（实时增量）。只跟踪区间，不保留时间序、不记时间线
 * （时间纪律：fiber-lens 只回答"现在"）。
 *
 * 内存纪律：会话数上限 8（按最近活跃 LRU 逐出）、参与集上限 256、
 * 在飞集合上限 64——观测者绝不能成为宿主的内存负担。
 * @module dsh-fiber-lens/participation
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** 参与集里 agent-loop 的固定 fiber 名（turn 与 step 事件 → 本轮驱动者）。 */
export const AGENT_LOOP_FIBER = 'agent-loop'

/** 会话跟踪数量上限（LRU 逐出）。 */
export const MAX_TRACKED_SESSIONS = 8
/** 单会话参与集上限。 */
export const MAX_PARTICIPANTS = 256
/** 单会话在飞集合上限。 */
export const MAX_INFLIGHT = 64
/** 参数摘要截断长度。 */
export const ARGS_SUMMARY_LENGTH = 80

/** 一条在飞调用（线上协议即此 JSON）。 */
export interface InflightEntry {
  /** tool/call 的 callId；合成条目（agent-loop 常亮）用 `#agent-loop`。 */
  callId: string
  /** 经手 fiber 名（命名约定映射结果，或原始工具名兜底）。 */
  fiberName: string
  /** 原始工具名。 */
  toolName: string
  /** 截断的参数摘要（~80 字符）。 */
  argsSummary: string
  /** 所在关口；P2 简化恒为 execute（pre/post 关口需要 waterfall 事件，内核未暴露）。 */
  gate: string
}

/** 参与查询结果。 */
export interface ParticipationResult {
  /** 命中的会话 id；无任何跟踪数据时为 null。 */
  session: string | null
  participants: string[]
  inflight: InflightEntry[]
}

/** 内部在飞记录：比线上条目多一个入队时间（LRU 逐出用，不上线）。 */
interface TrackedCall extends InflightEntry {
  startedAt: number
}

/** 单会话跟踪状态。 */
interface SessionTrack {
  participants: Set<string>
  inflight: Map<string, TrackedCall>
  /** 当前/最近 turn 编号。 */
  turn: number | null
  /** 当前/最近 step 编号。 */
  step: number | null
  /** turn 是否处于 start→end 区间内（agent-loop 常亮的依据）。 */
  turnOpen: boolean
  lastActivity: number
}

const newTrack = (): SessionTrack => ({
  participants: new Set(),
  inflight: new Map(),
  turn: null,
  step: null,
  turnOpen: false,
  lastActivity: Date.now(),
})

/** 工具名 → fiber 名的命名约定映射（设计 §10 Q7 的 fallback 路径）。 */
export function toolToFiberName(toolName: string, fiberNames: ReadonlySet<string>): string {
  const kebab = toolName.replace(/_/g, '-')
  const conventional = `tool-${kebab}`
  if (fiberNames.has(conventional)) return conventional
  // 次级兜底：fiber 名包含工具名（如 tool-bash-persistent 之于 bash）。
  for (const name of fiberNames) {
    if (name.includes(kebab)) return name
  }
  // 最终兜底：原始工具名自成节点。
  return toolName
}

/** 截断工具参数为单行摘要。 */
export function summarizeArgs(args: string): string {
  const flat = args.replace(/\s+/g, ' ').trim()
  return flat.length > ARGS_SUMMARY_LENGTH ? `${flat.slice(0, ARGS_SUMMARY_LENGTH - 1)}…` : flat
}

/**
 * 参与集跟踪器：会话事件流 → 每会话 {参与集, 在飞集合, turn/step}。
 * fiberNames 提供者惰性求值（事件频率低，快照本身有 version 缓存）。
 */
export class ParticipationTracker {
  private readonly tracks = new Map<string, SessionTrack>()

  /**
   * @param fiberNames 当前快照的 fiber 名集合提供者（工具→fiber 映射的匹配底表）。
   */
  constructor(private readonly fiberNames: () => ReadonlySet<string>) {}

  /** session/created：从既有日志一次性推导累积参与集（resume/fork 的种子历史也算参与）。 */
  noteSession(session: Session): void {
    const track = newTrack()
    for (const event of session.events) this.applyEvent(track, event)
    this.tracks.set(String(session.id), track)
    this.evict()
  }

  /** session/event：实时增量。插件加载前已存在的会话没有 created，此处兜底建轨。 */
  noteEvent(session: Session, event: SessionEvent): void {
    const id = String(session.id)
    let track = this.tracks.get(id)
    if (track === undefined) {
      track = newTrack()
      this.tracks.set(id, track)
    }
    track.lastActivity = Date.now()
    this.applyEvent(track, event)
    this.evict()
  }

  /** session/disposed：立刻释放该会话的跟踪状态。 */
  dropSession(id: string): void {
    this.tracks.delete(id)
  }

  /** 是否已有该会话的跟踪数据（端点据此决定是否做 ctx.get('sessions') 追赶）。 */
  has(sessionId: string): boolean {
    return this.tracks.has(sessionId)
  }

  /**
   * 查询参与数据。sessionId 为 null 时回退到最近活跃会话
   * （客户端拿不到当前会话 id 的降级通路）；无任何跟踪数据时返回空。
   */
  query(sessionId: string | null): ParticipationResult {
    let id = sessionId
    if (id === null) {
      let best: string | null = null
      let bestAt = -1
      for (const [key, track] of this.tracks) {
        if (track.lastActivity > bestAt) {
          best = key
          bestAt = track.lastActivity
        }
      }
      id = best
    }
    const track = id === null ? undefined : this.tracks.get(id)
    if (id === null || track === undefined) return { session: null, participants: [], inflight: [] }
    const inflight: InflightEntry[] = [...track.inflight.values()].map((call) => ({
      callId: call.callId,
      fiberName: call.fiberName,
      toolName: call.toolName,
      argsSummary: call.argsSummary,
      gate: call.gate,
    }))
    // agent-loop 以 turn 区间为界常亮（它是本轮驱动者，常亮是诚实）。
    if (track.turnOpen && track.participants.has(AGENT_LOOP_FIBER)) {
      inflight.push({
        callId: `#${AGENT_LOOP_FIBER}`,
        fiberName: AGENT_LOOP_FIBER,
        toolName: AGENT_LOOP_FIBER,
        argsSummary: `turn ${track.turn ?? '?'}${track.step !== null ? ` · step ${track.step}` : ''}`,
        gate: 'execute',
      })
    }
    return { session: id, participants: [...track.participants].sort(), inflight }
  }

  /** 单事件增量应用；不参与执行路径呈现的事件（llm 流、user/message 等）直接跳过。 */
  private applyEvent(track: SessionTrack, event: SessionEvent): void {
    switch (event.type) {
      case 'tool/call': {
        const fiberName = toolToFiberName(event.data.name, this.fiberNames())
        if (track.participants.size < MAX_PARTICIPANTS) track.participants.add(fiberName)
        if (track.inflight.size >= MAX_INFLIGHT) {
          // 上限逐出最旧条目（Map 迭代序即插入序）。
          const oldest = track.inflight.keys().next()
          if (!oldest.done) track.inflight.delete(oldest.value)
        }
        const callId = String(event.data.callId)
        track.inflight.set(callId, {
          callId,
          fiberName,
          toolName: event.data.name,
          argsSummary: summarizeArgs(event.data.arguments),
          gate: 'execute',
          startedAt: event.time,
        })
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        if (block !== undefined) track.inflight.delete(String(block.toolCallId))
        break
      }
      case 'turn/start':
        if (track.participants.size < MAX_PARTICIPANTS) track.participants.add(AGENT_LOOP_FIBER)
        track.turn = event.data.turn
        track.turnOpen = true
        break
      case 'turn/end':
        track.turnOpen = false
        break
      case 'step/start':
        if (track.participants.size < MAX_PARTICIPANTS) track.participants.add(AGENT_LOOP_FIBER)
        track.step = event.data.step
        break
      default:
        // llm/* 与 user/message 等：llm provider 归属无法从事件可靠识别（P2 跳过）。
        break
    }
  }

  /** LRU 逐出：超出会话上限时丢弃最不活跃的轨道。 */
  private evict(): void {
    while (this.tracks.size > MAX_TRACKED_SESSIONS) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, track] of this.tracks) {
        if (track.lastActivity < oldestAt) {
          oldestKey = key
          oldestAt = track.lastActivity
        }
      }
      if (oldestKey === null) return
      this.tracks.delete(oldestKey)
    }
  }
}

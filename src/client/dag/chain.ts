/**
 * 焦点链计算层（snapshot → diff → focus → chain → layout → render 管线的 chain 段，纯函数）。
 * 双向 BFS：上游沿 inject → 服务名 → provider；下游沿 provides → 服务名 → consumer。
 * visited 防环；跳数上限 ±maxHops，超限计为截断（+N 端点）。
 * @module dsh-fiber-lens/client/dag/chain
 */
import type { FiberNode, ServiceRow } from '../store.ts'

/** 链节点：fiber + 相对焦点的依赖跳数（焦点 0，上游负，下游正）。 */
export interface ChainNode {
  fiber: FiberNode
  hop: number
}

/** 服务依赖边：provider → consumer，标注服务名。 */
export interface ChainEdge {
  fromUid: string
  toUid: string
  service: string
}

/** 焦点链计算结果。 */
export interface ChainResult {
  focusUid: string
  /** uid → 链节点。 */
  nodes: Map<string, ChainNode>
  edges: ChainEdge[]
  /** uid → 该节点被跳数上限截断的隐藏邻居数（渲染 +N 角标）。 */
  truncated: Map<string, number>
  /** 焦点之外无任何链上邻居（孤立插件）。 */
  isolated: boolean
}

/** 默认跳数上限（设计 v0.5 §3.1：±3）。 */
export const DEFAULT_MAX_HOPS = 3

/**
 * 构建焦点链。
 * @param focusUid 焦点 fiber uid
 * @param fibers 快照 fiber 列表
 * @param services 快照服务列表（name → ownerUid 为 provider 映射源）
 * @param maxHops 单方向最大跳数
 * @returns 链；焦点 uid 不存在或为 null 时返回 null
 */
export function buildChain(
  focusUid: string,
  fibers: FiberNode[],
  services: ServiceRow[],
  maxHops: number = DEFAULT_MAX_HOPS,
): ChainResult | null {
  const byUid = new Map<string, FiberNode>()
  for (const fiber of fibers) if (fiber.uid !== null) byUid.set(fiber.uid, fiber)
  const focus = byUid.get(focusUid)
  if (focus === undefined) return null

  // 服务名 → provider uid（多属主取第一个 active 的，全不 active 取第一个）
  const providerOf = new Map<string, string>()
  for (const service of services) {
    if (service.ownerUid === null) continue
    const existing = providerOf.get(service.name)
    if (existing === undefined) {
      providerOf.set(service.name, service.ownerUid)
    } else {
      const existingFiber = byUid.get(existing)
      if (existingFiber !== undefined && existingFiber.state !== 'active' && service.ownerState === 'active') {
        providerOf.set(service.name, service.ownerUid)
      }
    }
  }
  // 服务名 → consumer uid 列表（inject 声明含该服务）
  const consumersOf = new Map<string, string[]>()
  for (const fiber of fibers) {
    if (fiber.uid === null) continue
    for (const key of fiber.inject) {
      const list = consumersOf.get(key)
      if (list === undefined) consumersOf.set(key, [fiber.uid])
      else list.push(fiber.uid)
    }
  }

  const nodes = new Map<string, ChainNode>()
  const edges: ChainEdge[] = []
  const truncated = new Map<string, number>()
  const edgeSeen = new Set<string>()

  const pushEdge = (fromUid: string, toUid: string, service: string): void => {
    const key = `${fromUid}→${toUid}:${service}`
    if (edgeSeen.has(key)) return
    edgeSeen.add(key)
    edges.push({ fromUid, toUid, service })
  }

  const bumpTruncated = (uid: string): void => {
    truncated.set(uid, (truncated.get(uid) ?? 0) + 1)
  }

  // 上游 BFS：fiber 的 inject 服务 → provider
  const upQueue: string[] = [focusUid]
  nodes.set(focusUid, { fiber: focus, hop: 0 })
  while (upQueue.length > 0) {
    const uid = upQueue.shift() ?? ''
    const node = nodes.get(uid)
    if (node === undefined) continue
    for (const service of node.fiber.inject) {
      const providerUid = providerOf.get(service)
      if (providerUid === undefined || providerUid === uid) continue
      const provider = byUid.get(providerUid)
      if (provider === undefined) continue
      pushEdge(providerUid, uid, service)
      const existing = nodes.get(providerUid)
      if (existing !== undefined) continue
      const hop = node.hop - 1
      if (Math.abs(hop) > maxHops) {
        bumpTruncated(uid)
        continue
      }
      nodes.set(providerUid, { fiber: provider, hop })
      upQueue.push(providerUid)
    }
  }

  // 下游 BFS：fiber 的 provides 服务 → consumer
  const downQueue: string[] = [focusUid]
  while (downQueue.length > 0) {
    const uid = downQueue.shift() ?? ''
    const node = nodes.get(uid)
    if (node === undefined) continue
    for (const service of node.fiber.provides) {
      for (const consumerUid of consumersOf.get(service) ?? []) {
        if (consumerUid === uid) continue
        const consumer = byUid.get(consumerUid)
        if (consumer === undefined) continue
        pushEdge(uid, consumerUid, service)
        const existing = nodes.get(consumerUid)
        if (existing !== undefined) continue
        const hop = node.hop + 1
        if (Math.abs(hop) > maxHops) {
          bumpTruncated(uid)
          continue
        }
        nodes.set(consumerUid, { fiber: consumer, hop })
        downQueue.push(consumerUid)
      }
    }
  }

  return { focusUid, nodes, edges, truncated, isolated: nodes.size === 1 }
}

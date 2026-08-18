/**
 * Fiber Lens — DSH 运行时可视化插件（Host 半身）。
 *
 * 设计原则：零 inject 骨架。fiber 树数据全部来自 Cordis 内核 API
 * （ctx.registry / ctx.reflect.store / internal/* 事件），不声明任何
 * 硬依赖——被观测系统崩溃时观测者必须仍然活着。webServer 通过
 * ctx.inject 回调式可选挂载：无 web 环境时插件照常加载，只是没有路由。
 *
 * 路由（同源 JSON）：
 *   GET /api/fiber-lens/ping     → { version }            轻量心跳
 *   GET /api/fiber-lens/snapshot → { version, at, fibers, services }  全量快照
 *
 * version 由 internal/status / internal/plugin / internal/service 事件
 * 驱动递增；浏览器侧每秒 ping，version 变化才拉全量快照。
 * @module dsh-fiber-lens
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only side-effect import: pull the webServer Context augmentation in.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export const name = 'fiber-lens'

/** 浏览器侧 API 前缀。 */
export const API_PREFIX = '/api/fiber-lens'

/**
 * FiberState 是 const enum，运行时不存在对象；镜像数值 → 标签。
 * 与 vendor/cordis/src/fiber.ts 的声明顺序一致。
 */
const STATE_LABELS = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

/** 一个 fiber 节点的快照行（全部叶子标量，绝无活对象引用）。 */
export interface FiberNode {
  /** fiber.uid；取不到时为 null。 */
  uid: string | null
  name: string
  state: string
  /** 距 root 的挂载深度（沿 parent 链计算）。 */
  depth: number
  /** parent fiber 的 uid；root 或不可达时为 null。 */
  parentUid: string | null
  /** inject 声明的服务名（强依赖）。 */
  inject: string[]
  /** inject 声明了但当前不存在的服务 —— PENDING 的原因。 */
  missing: string[]
  /** 该 fiber 提供的服务名（从 reflect.store 按属主 join）。 */
  provides: string[]
}

/** 一个活服务注册行。 */
export interface ServiceRow {
  name: string
  ownerUid: string | null
  ownerName: string
  ownerState: string
}

/** 全量快照。 */
export interface LensSnapshot {
  version: number
  at: number
  fibers: FiberNode[]
  services: ServiceRow[]
}

/** 安全读取 fiber.uid（不同 cordis 版本字段可能有变）。 */
function fiberUid(fiber: Fiber): string | null {
  try {
    const uid = (fiber as { uid?: unknown }).uid
    return typeof uid === 'string' ? uid : null
  } catch {
    return null
  }
}

/** 沿 parent 链计算深度与父 uid；任何一环异常都截断返回已得值。 */
function climb(fiber: Fiber): { depth: number; parentUid: string | null } {
  let depth = 0
  let parentUid: string | null = null
  try {
    let current = fiber
    while (true) {
      const parent = (current.parent as { fiber?: Fiber } | undefined)?.fiber
      if (parent === undefined || parent === current) break
      if (depth === 0) parentUid = fiberUid(parent)
      depth++
      current = parent
      if (depth > 64) break // 防御：异常环
    }
  } catch {
    // 截断：返回已计算的部分
  }
  return { depth, parentUid }
}

/** 从 reflect.store 收集活服务注册（symbol-keyed impl 记录）。 */
function liveImpls(ctx: Context): { name: string; fiber: Fiber }[] {
  const store = ctx.reflect.store as Record<symbol, { name: string; fiber: Fiber } | undefined>
  return Object.getOwnPropertySymbols(store)
    .map((key) => store[key])
    .filter((impl): impl is { name: string; fiber: Fiber } => impl !== undefined)
}

/** 构建全量快照。 */
export function buildSnapshot(ctx: Context, version: number): LensSnapshot {
  const impls = liveImpls(ctx)
  const byFiber = new Map<Fiber, string[]>()
  for (const impl of impls) {
    const list = byFiber.get(impl.fiber) ?? []
    list.push(impl.name)
    byFiber.set(impl.fiber, list)
  }

  const fibers: FiberNode[] = []
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      const injectKeys = Object.keys(fiber.inject)
      const missing = injectKeys.filter((service) => {
        try {
          return ctx.get(service) === undefined
        } catch {
          return false
        }
      })
      const { depth, parentUid } = climb(fiber)
      fibers.push({
        uid: fiberUid(fiber),
        name: String(fiber.name),
        state: STATE_LABELS[fiber.state as number] ?? String(fiber.state),
        depth,
        parentUid,
        inject: injectKeys,
        missing,
        provides: (byFiber.get(fiber) ?? []).sort(),
      })
    }
  }
  fibers.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))

  const services: ServiceRow[] = impls
    .map((impl) => ({
      name: impl.name,
      ownerUid: fiberUid(impl.fiber),
      ownerName: String(impl.fiber.name),
      ownerState: STATE_LABELS[impl.fiber.state as number] ?? String(impl.fiber.state),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { version, at: Date.now(), fibers, services }
}

/** 写 JSON 响应。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function apply(ctx: Context): void {
  // 版本计数器：任何 fiber 状态变化 / 插件挂载 / 服务注册注销都递增。
  // 浏览器侧 ping 比对 version，变了才拉全量快照 —— 事件驱动 + 轮询外壳。
  let version = 0
  const bump = (): void => { version++ }
  ctx.on('internal/status', bump)
  ctx.on('internal/plugin', bump)
  ctx.on('internal/service', bump)

  // 快照缓存：version 变化即作废，下一次 snapshot 请求重建。
  let cached: LensSnapshot | undefined
  let cachedVersion = -1
  const snapshot = (): LensSnapshot => {
    if (cached === undefined || cachedVersion !== version) {
      cached = buildSnapshot(ctx, version)
      cachedVersion = version
    }
    return cached
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/ping`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        json(res, 200, { ok: true, version })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/snapshot`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          json(res, 200, { ok: true, snapshot: snapshot() })
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
  ]

  // webServer 是可选能力：web profile 提供它，headless/CLI 没有。
  // 回调式 inject 不构成本插件的硬依赖 —— 没有 webServer 时插件照常 ACTIVE。
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = routes.map((route) => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'fiber-lens: routes')
  })
}

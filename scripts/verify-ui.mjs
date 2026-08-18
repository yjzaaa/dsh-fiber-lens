// Fiber Lens 面板目检脚本：CDP 驱动 Chrome 打开 dsh web，点开 Fiber Lens，截图。
// 用法: node scripts/verify-ui.mjs [outDir]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? 'verify-shots'
const PORT = 9333
const URL_APP = 'http://127.0.0.1:3080/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new', '--disable-gpu', '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdp() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP not ready')
}

async function main() {
  const ws = new WebSocket(await cdp())
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
  await new Promise((r) => { ws.onopen = r })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
    console.log('shot:', name)
  }
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result?.value
  }

  await send('Page.navigate', { url: URL_APP })
  await sleep(9000) // 等 SPA + 客户端插件加载
  await shot('01-home.png')

  // 找 Fiber Lens 触发按钮并点击
  const clicked = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => /Fiber Lens/i.test(x.textContent || '') || /Fiber Lens/i.test(x.title || x.ariaLabel || ''))
    if (b) { b.click(); return true }
    return false
  })()`)
  console.log('trigger clicked:', clicked)
  await sleep(3500)
  await shot('02-panel-list.png')

  // 切到 DAG 视图
  const dagClicked = await evalJs(`(() => {
    const els = [...document.querySelectorAll('button, [role="button"], div')]
    const b = els.find((x) => /DAG/.test(x.textContent || '') && (x.textContent || '').length < 12)
    if (b) { b.click(); return b.textContent }
    return null
  })()`)
  console.log('dag toggle:', dagClicked)
  await sleep(3500)
  await shot('03-panel-dag.png')

  // 面板状态汇报
  const state = await evalJs(`(() => {
    const panel = document.querySelector('[class*="panel"]')
    return {
      hasPanel: !!panel,
      svgNodes: document.querySelectorAll('svg g, svg rect').length,
      bodyText: (document.body.innerText || '').slice(0, 400),
    }
  })()`)
  console.log('panel state:', JSON.stringify(state, null, 2))

  ws.close()
  chrome.kill()
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })

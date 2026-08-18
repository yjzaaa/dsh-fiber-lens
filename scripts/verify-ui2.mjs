// Fiber Lens DAG 交互测试：展开子树、缩放、点击节点。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'verify-shots'
const PORT = 9334
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let ws
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page')
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break }
    } catch { /* retry */ }
    await sleep(500)
  }
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
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
    console.log('shot:', name)
  }
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value

  await send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
  await sleep(9000)
  // 打开面板 → 切 DAG
  await evalJs(`[...document.querySelectorAll('button')].find((x) => /Fiber Lens/i.test(x.title || ''))?.click()`)
  await sleep(2500)
  await evalJs(`[...document.querySelectorAll('button')].find((x) => /DAG/.test(x.textContent || ''))?.click()`)
  await sleep(2500)

  // 1. 点击 AgentLoop 节点（展开子树 + 选中）
  const clicked = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('svg text')]
    const t = texts.find((x) => /AgentLoop/.test(x.textContent || ''))
    if (!t) return 'no-text'
    const g = t.closest('g')
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    g.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'clicked'
  })()`)
  console.log('node click:', clicked)
  await sleep(2000)
  await shot('04-dag-expanded.png')

  // 2. 滚轮放大到 READ/FULL 档
  const svg = await evalJs(`(() => {
    const svg = document.querySelector('svg')
    if (!svg) return 'no-svg'
    const r = svg.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (svg !== 'no-svg') {
    for (let i = 0; i < 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: svg.x, y: svg.y, deltaX: 0, deltaY: -240 })
      await sleep(120)
    }
  }
  await sleep(2000)
  await shot('05-dag-zoomed.png')

  // 3. 汇报节点数与档位
  const state = await evalJs(`(() => {
    const svg = document.querySelector('svg')
    return {
      rects: svg ? svg.querySelectorAll('rect').length : 0,
      texts: svg ? [...svg.querySelectorAll('text')].map((t) => t.textContent).slice(0, 25) : [],
      hint: (document.body.innerText.match(/阅读|MAP|READ|FULL|100%|175%/g) || []).join(','),
    }
  })()`)
  console.log('state:', JSON.stringify(state, null, 2))
  ws.close(); chrome.kill()
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })

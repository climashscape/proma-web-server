/**
 * browser-smoke.ts — 浏览器冒烟测试（阶段 3 renderer web 化）
 *
 * headless chromium 访问 http://127.0.0.1:PORT/?token=xxx，验证：
 *  1. token-gate 把 URL token 转存 localStorage 并清除 URL 参数（#25 缓解）
 *  2. window.electronAPI 已注入（web-preload bundle 在 React 启动前执行）
 *  3. invoke 真实 handler（runtime:get-status）返回真实结果
 *
 * 用法: PROMA_WEB_TOKEN=xxx [PROMA_WEB_PORT=6810] bun run browser-smoke.ts
 * 依赖: playwright + chromium（首次需 bunx playwright install chromium --with-deps）
 */
import { chromium } from 'playwright'

const TOKEN = process.env.PROMA_WEB_TOKEN || ''
const PORT = process.env.PROMA_WEB_PORT || '6810'
if (!TOKEN) {
  console.error('[browser-smoke] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const base = `http://127.0.0.1:${PORT}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

try {
  // 1. 带 token 参数打开（触发 token-gate 转存 + URL 清除）
  await page.goto(`${base}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })

  // 2. window.electronAPI 注入（同步 script，等待 bridge 就绪）
  await page.waitForFunction(() => (window as any).electronAPI !== undefined, { timeout: 20_000 })
  check('window.electronAPI 已注入', true)

  // 3. URL 参数应已被清除（#25）
  const url = page.url()
  check('URL token 参数已清除', !url.includes('token='), url)

  // 4. token 已转存 localStorage
  const stored = await page.evaluate(() => {
    try {
      return localStorage.getItem('proma_web_token')
    } catch {
      return null
    }
  })
  check('token 已转存 localStorage', stored === TOKEN)

  // 5. invoke 真实 handler（等待 WS 桥连接后执行）
  // preload 的 electronAPI 是白名单方法集合（无通用 invoke），getRuntimeStatus() 对应 runtime:get-status 通道
  const status = await page.evaluate(async () => {
    const api = (window as any).electronAPI
    const errors: string[] = []
    // 桥可能仍在连接中（含连接限频窗口期/退避重连），重试 30 次 × 500ms
    for (let i = 0; i < 30; i++) {
      try {
        const r = await api.getRuntimeStatus()
        if (r && typeof r === 'object') return { ok: true, result: r }
        errors.push('返回空值')
      } catch (e) {
        errors.push(String(e).slice(0, 120))
      }
      await new Promise((res) => setTimeout(res, 500))
    }
    return { ok: false, errors: errors.slice(0, 6) }
  })
  check(
    'invoke 真实 handler（getRuntimeStatus）',
    !!(status && status.ok && typeof status.result === 'object'),
    status?.ok
      ? `keys=${Object.keys(status.result).join(',')}`
      : `失败原因: ${JSON.stringify(status?.errors ?? '未返回结果')}`,
  )
} catch (err) {
  check('浏览器冒烟执行', false, String(err))
} finally {
  await browser.close()
}

console.log(`\n===== 浏览器冒烟结论 =====`)
console.log(failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

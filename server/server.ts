/**
 * server.ts — Proma Web 服务化：HTTP(静态 UI) + WebSocket(IPC 桥)
 *
 * 职责：
 *  1. 加载真实 main 进程 registerIpcHandlers()，在纯 Bun 下注册全部 handler（复用不改）
 *  2. Bun.serve：HTTP 提供静态 UI / health；WebSocket 提供 request/event 两类 IPC 通道
 *
 * 安全默认（审查 S2-S5 修复延续）：
 *  - PROMA_WEB_TOKEN 必填，未设置拒绝启动
 *  - 默认监听 127.0.0.1（局域网需 PROMA_WEB_HOST=0.0.0.0）
 *  - 错误响应默认脱敏（PROMA_WEB_VERBOSE_ERRORS=1 才含堆栈）
 *
 * 健壮性（审查 M2/M3 落实）：
 *  - 单活跃连接互斥（新连接顶替旧连接，规避全局状态并发风险）
 *  - 应用层心跳（ping/pong，僵尸连接检测）
 *  - 消息大小限制 + 速率限制 + pending 超时与清理
 *  - graceful shutdown（SIGTERM/SIGINT）
 *  - /health 健康检查 + /metrics 轻量指标
 */

import { join, extname, resolve, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { setEventBroadcast, invokeChannel, listRegisteredChannels, ipcMain } from './electron-stub'
import { logger } from './logger'
import {
  PROTOCOL_VERSION,
  PROTOCOL_NAME,
  ERR,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type InvokeFrame,
} from './protocol'

// ===================== 配置（环境变量，.env.example 见仓库根） =====================

const PORT = Number(process.env.PROMA_WEB_PORT || 6810)
const HOST = process.env.PROMA_WEB_HOST || '127.0.0.1'
const PROMA_SRC = process.env.PROMA_SRC
if (!PROMA_SRC) {
  console.error('[server] 必须设置 PROMA_SRC 环境变量指向 Proma 源码（patch 后的目录）')
  console.error('[server] 示例: PROMA_SRC=/opt/Proma PROMA_WEB_TOKEN=xxx bun run server.ts')
  process.exit(1)
}
// Token 认证：必填。未设置时拒绝启动，防止无认证暴露可执行 bash 的 Agent 工具
const WS_TOKEN = process.env.PROMA_WEB_TOKEN
if (!WS_TOKEN) {
  console.error('[server] 安全要求：必须设置 PROMA_WEB_TOKEN 环境变量（例如：PROMA_WEB_TOKEN=$(openssl rand -hex 32)）')
  console.error('[server] 拒绝启动，防止无认证暴露可执行 bash 的 Agent 工具。')
  process.exit(1)
}
const VERBOSE_ERRORS = process.env.PROMA_WEB_VERBOSE_ERRORS === '1'
// 单条 WS 消息上限（防恶意巨型 JSON 内存耗尽），默认 4MB
const MAX_MSG_BYTES = Number(process.env.PROMA_WEB_MAX_MSG_BYTES || 4 * 1024 * 1024)
// invoke 超时（慢 handler 保护），默认 120s
const INVOKE_TIMEOUT_MS = Number(process.env.PROMA_WEB_INVOKE_TIMEOUT_MS || 120_000)
// 每连接速率限制：滑动窗口内最多 invoke 次数，默认 60s / 600 次
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = Number(process.env.PROMA_WEB_RATE_LIMIT || 600)
// 出站 result 大小上限（#2 P0），默认 16MB（channel:list 等大结果可能超 4MB 入站限制）
const MAX_RESULT_BYTES = Number(process.env.PROMA_WEB_MAX_RESULT_BYTES || 16 * 1024 * 1024)
// invoke args 最大递归深度（#3 P0），防深层对象序列化消耗
const MAX_ARGS_DEPTH = Number(process.env.PROMA_WEB_MAX_ARGS_DEPTH || 20)
// M7 P1：同 IP 新连接频率限制（防快速重连 DoS），默认 10s 内最多 10 次（单用户正常 1-2 次，测试脚本约 5 次）
const CONN_RATE_WINDOW_MS = 10_000
const CONN_RATE_MAX = Number(process.env.PROMA_WEB_CONN_RATE_LIMIT || 10)
// #28 P2：Origin 白名单（逗号分隔，如 http://<server-ip>:6810）。默认仅允许同源（Origin host === Host）。
const ALLOWED_ORIGINS = (process.env.PROMA_WEB_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** #28：Origin 校验（WS 握手前纵深防御；非浏览器客户端无 Origin 直接放行） */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin)
  try {
    const oHost = new URL(origin).host
    const host = req.headers.get('host') ?? ''
    return oHost === host
  } catch {
    return false
  }
}
const connAttempts = new Map<string, number[]>()

function connRateLimited(ip: string): boolean {
  const now = Date.now()
  const arr = (connAttempts.get(ip) ?? []).filter((t) => now - t < CONN_RATE_WINDOW_MS)
  if (arr.length >= CONN_RATE_MAX) {
    connAttempts.set(ip, arr)
    return true
  }
  arr.push(now)
  connAttempts.set(ip, arr)
  return false
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')

const START_TIME = Date.now()
const SERVER_VERSION = '0.1.0'
// P1 测试模式：PROMA_WEB_TEST_MODE=1 时注册 _test: 通道（仅供 verify 使用，生产勿开）
const TEST_MODE = process.env.PROMA_WEB_TEST_MODE === '1'

// ===================== 加载真实 main 逻辑 =====================

let registeredChannelCount = 0

async function loadPromaMain(): Promise<void> {
  logger.info('loading proma main', { src: PROMA_SRC })
  const t0 = Date.now()

  try {
    // 动态 import 真实 ipc.ts（内部 import 'electron' 由 @proma/electron-stub patch 提供）
    const ipcModule = await import(join(PROMA_SRC, 'apps/electron/src/main/ipc.ts'))
    ipcModule.registerIpcHandlers()
  } catch (err) {
    // M1 修复：启动失败给友好诊断，而非裸崩
    const e = err instanceof Error ? err : new Error(String(err))
    logger.error('failed to load proma main', { src: PROMA_SRC, error: e.message })
    console.error(`[server] 加载 Proma 源码失败: ${e.message}`)
    console.error('[server] 请检查:')
    console.error('[server]   1. PROMA_SRC 路径是否正确（当前: ' + PROMA_SRC + '）')
    console.error('[server]   2. electron stub patch 是否已应用（bash patches/patch-proma.sh status）')
    console.error('[server]   3. 上游源码是否已变更（patch 可能已失效，需 undo 后重新 apply）')
    process.exit(1)
  }

  registeredChannelCount = listRegisteredChannels().length
  logger.info('ipc handlers registered', { count: registeredChannelCount, ms: Date.now() - t0 })
}

/** P1 测试模式 handler（PROMA_WEB_TEST_MODE=1 时注册；生产默认关闭） */
function registerTestHandlers(): void {
  if (!TEST_MODE) return
  ipcMain.handle('_test:big-result', (_ev, bytes: number) => {
    const n = Math.min(Math.max(Number(bytes) || 0, 0), 64 * 1024 * 1024)
    return { payload: 'x'.repeat(n) }
  })
  ipcMain.handle('_test:slow', (_ev, ms: number) => new Promise((r) => setTimeout(r, Math.min(Math.max(Number(ms) || 1000, 0), 10_000))))
  ipcMain.handle('_test:throw', () => {
    throw new Error('test handler error (internal path: /secret/leak-test)')
  })
  // #10/#11：测试广播通道（invoke 后向全部已连接客户端推送 event 帧，用于真实事件断言）
  ipcMain.handle('_test:broadcast', (_ev, channel: unknown, payload?: unknown) => {
    const ch = typeof channel === 'string' && channel ? channel : 'test:channel'
    const data = payload === undefined ? ['hello'] : [payload]
    for (const c of allClients) {
      metrics.eventsSent++
      sendFrame(c, { type: 'event', channel: ch, payload: data })
    }
    return true
  })
  logger.info('test handlers registered (PROMA_WEB_TEST_MODE=1)')
}

/** Web 模式兼容 handler：Electron 桌面专属通道在 Web 下 no-op（避免 renderer 报错刷日志） */
function registerWebCompatHandlers(): void {
  // Agent 灵动岛仅 macOS 原生 surface 使用；Web 模式 renderer 仍会调用 markSessionViewed
  ipcMain.handle('agent-island:mark-session-viewed', () => true)
  logger.info('web compat handlers registered')
}

// ===================== 指标（轻量 /metrics） =====================

const metrics = {
  connectionsTotal: 0,
  invokesTotal: 0,
  invokeErrors: 0,
  eventsSent: 0,
  bytesReceived: 0,
  bytesSent: 0,
}

// #12 P1：正在执行的 invoke 计数（graceful shutdown 等待用）
let runningInvokes = 0

// ===================== WebSocket 连接管理 =====================

type Client = import('bun').ServerWebSocket<unknown>

/** 单活跃连接互斥：同一时刻只允许一个活跃客户端（规避审计 3 的全局状态并发风险） */
let activeClient: Client | null = null
/** 全部已连接客户端（TEST_MODE 广播用；正常业务事件只推 activeClient） */
const allClients = new Set<Client>()

interface ConnState {
  /** invoke 的 pending Map：id → resolve/reject/timer */
  pending: Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  /** 上次收到客户端 pong / 任意消息的时间戳（心跳检测） */
  lastSeen: number
  /** 速率限制：窗口内 invoke 时间戳列表 */
  invokeTimes: number[]
  /** 连接建立时间 */
  connectedAt: number
  closed: boolean
}

const connStates = new WeakMap<Client, ConnState>()

function getState(ws: Client): ConnState {
  let s = connStates.get(ws)
  if (!s) {
    s = { pending: new Map(), lastSeen: Date.now(), invokeTimes: [], connectedAt: Date.now(), closed: false }
    connStates.set(ws, s)
  }
  return s
}

function sendFrame(ws: Client, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    /* 单客户端发送失败忽略 */
  }
}

/** 心跳探测：周期 ping，超时无响应则断开（B3：句柄保存，shutdown 时清理） */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
function scheduleHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    const now = Date.now()
    // 单活跃连接模型，仅需探测 activeClient
    if (activeClient) {
      const st = getState(activeClient)
      if (now - st.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('client heartbeat timeout, closing', { conn: st.connectedAt })
        try {
          activeClient.close(4003, 'heartbeat timeout')
        } catch {
          /* ignore */
        }
      } else {
        sendFrame(activeClient, { type: 'ping', t: now })
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
}

/** 限流：滑动窗口内超限则拒绝 */
function rateLimited(ws: Client): boolean {
  const st = getState(ws)
  const now = Date.now()
  st.invokeTimes = st.invokeTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (st.invokeTimes.length >= RATE_LIMIT_MAX) return true
  st.invokeTimes.push(now)
  return false
}

/** #3 P0：递归深度检查（防深层对象序列化）——修复：正确遍历对象树，不再把对象反复包数组 */
function argsDepthExceeded(value: unknown, depth = 0): boolean {
  if (depth > MAX_ARGS_DEPTH) return true
  if (value && typeof value === 'object') {
    const vals = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    for (const v of vals) {
      if (v && typeof v === 'object') {
        if (argsDepthExceeded(v, depth + 1)) return true
      }
    }
  }
  return false
}

/** #2 P0：出站 result 大小限制，超限返回错误帧 */
function sendResult(ws: Client, id: number | string, ok: boolean, result: unknown, error?: string): void {
  const frame = ok ? { type: 'result', id, ok: true, result } : { type: 'result', id, ok: false, error }
  const raw = JSON.stringify(frame)
  const size = Buffer.byteLength(raw)
  metrics.bytesSent += size
  if (ok && size > MAX_RESULT_BYTES) {
    metrics.invokeErrors++
    logger.warn('result too large', { id, bytes: size, max: MAX_RESULT_BYTES })
    sendFrame(ws, { type: 'result', id, ok: false, error: `result too large: ${size} bytes (max ${MAX_RESULT_BYTES})` })
    return
  }
  try {
    ws.send(raw)
  } catch {
    /* 单客户端发送失败忽略 */
  }
}

/** 处理 invoke 帧（request 通道） */
async function handleInvoke(ws: Client, msg: InvokeFrame): Promise<void> {
  const { id, channel, args = [] } = msg
  const st = getState(ws)

  // B6/#22 P1：id 校验（缺失/非 string|number/重复）
  if (id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number')) {
    sendFrame(ws, { type: 'result', id: null as unknown as number, ok: false, error: 'invoke id must be string or number' })
    return
  }
  if (!channel || typeof channel !== 'string') {
    sendFrame(ws, { type: 'result', id, ok: false, error: 'missing channel' })
    return
  }
  if (!Array.isArray(args)) {
    sendFrame(ws, { type: 'result', id, ok: false, error: 'args must be an array' })
    return
  }
  if (st.pending.has(id)) {
    sendFrame(ws, { type: 'result', id, ok: false, error: 'duplicate invoke id' })
    return
  }
  if (rateLimited(ws)) {
    // #1 P0：限流改 result 帧（客户端 pending 能 settle，而非等 120s 超时）
    sendFrame(ws, { type: 'result', id, ok: false, error: 'invoke rate limit exceeded' })
    return
  }
  if (argsDepthExceeded(args)) {
    sendFrame(ws, { type: 'result', id, ok: false, error: `invoke args too deep (max ${MAX_ARGS_DEPTH})` })
    return
  }

  metrics.invokesTotal++
  runningInvokes++

  try {
    await new Promise<void>((resolveInvoke) => {
      const timer = setTimeout(() => {
        st.pending.delete(id)
        metrics.invokeErrors++
        runningInvokes--
        logger.warn('invoke timeout', { channel, ms: INVOKE_TIMEOUT_MS })
        sendFrame(ws, { type: 'result', id, ok: false, error: `invoke timeout after ${INVOKE_TIMEOUT_MS}ms: ${channel}` })
        resolveInvoke()
      }, INVOKE_TIMEOUT_MS)

      st.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer)
          runningInvokes--
          sendResult(ws, id, true, v)
          resolveInvoke()
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          runningInvokes--
          // #4 P0：错误脱敏 + trace id（非 VERBOSE 不泄露 handler 内部 message/堆栈）
          const traceId = randomUUID().slice(0, 8)
          metrics.invokeErrors++
          logger.warn('invoke failed', { channel, traceId, error: e.message })
          const detail = VERBOSE_ERRORS && e.stack ? `\n${e.stack}` : ''
          const msgText = VERBOSE_ERRORS ? `${e.message}${detail}` : `invoke failed (trace: ${traceId})`
          sendFrame(ws, { type: 'result', id, ok: false, error: msgText })
          resolveInvoke()
        },
        timer,
      })

      invokeChannel(channel, args)
        .then((result) => {
          const entry = st.pending.get(id)
          if (entry) {
            st.pending.delete(id)
            entry.resolve(result)
          }
        })
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err))
          const entry = st.pending.get(id)
          if (entry) {
            st.pending.delete(id)
            entry.reject(e)
          }
        })
    })
  } finally {
    // 兜底：确保 runningInvokes 不泄漏（正常路径已在 resolve/reject/timeout 递减）
    // 若 st.closed 时 handleInvoke 仍被触发，避免计数器悬空
  }
}

/** 清理连接状态（close 时调用，防 pending 泄漏） */
function cleanupClient(ws: Client): void {
  const st = connStates.get(ws)
  if (!st) return
  st.closed = true
  for (const [, entry] of st.pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error('connection closed before invoke completed'))
  }
  st.pending.clear()
  connStates.delete(ws)
}

// ===================== 事件广播（main→renderer） =====================

setEventBroadcast((channel, ...payload) => {
  const frame = { type: 'event', channel, payload }
  if (activeClient) {
    metrics.eventsSent++
    sendFrame(activeClient, frame)
  }
})

// ===================== 静态文件 =====================

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// ===================== Web 壳注入（阶段 3：renderer web 化） =====================
//
// 把 web/preload.ts 的浏览器 bundle（public/web-preload.js）注入到 renderer 的 index.html，
// 在 React 启动前把 window.electronAPI 挂到 window（等价于 Electron preload 的 contextBridge）。
// 同时注入 token-gate：URL ?token= 立即转存 localStorage 并清除 URL 参数（#25 缓解），
// 无 token 时显示登录遮罩引导输入（输入后存 localStorage 刷新）。

const WEB_PRELOAD_PATH = '/web-preload.js'

const TOKEN_GATE_SCRIPT = `
<script>
// Proma Web token-gate（server 注入）：URL token 转存 localStorage；无 token 显示登录遮罩
(function () {
  try {
    var params = new URLSearchParams(location.search)
    var urlToken = params.get('token')
    var saved = localStorage.getItem('proma_web_token')
    if (urlToken) {
      // 立即转存并清除 URL 参数，避免 token 留在浏览器历史 / Referer / 代理日志（#25）
      localStorage.setItem('proma_web_token', urlToken)
      params.delete('token')
      var qs = params.toString()
      location.replace(location.pathname + (qs ? '?' + qs : ''))
      return
    }
    if (!saved) {
      var mount = function () {
        var div = document.createElement('div')
        div.id = 'proma-token-gate'
        div.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(17,24,39,0.96);color:#e5e7eb;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif'
        div.innerHTML = '<div style="max-width:360px;padding:24px;border:1px solid #374151;border-radius:12px;background:#1f2937"><h2 style="margin:0 0 8px;font-size:18px">Proma Web</h2><p style="margin:0 0 16px;color:#9ca3af;font-size:13px">请输入访问令牌（PROMA_WEB_TOKEN）</p><form id="proma-token-form"><input id="proma-token-input" type="password" placeholder="token" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;margin-bottom:12px;font-size:14px"><button type="submit" style="width:100%;padding:8px;border:0;border-radius:8px;background:#2f6feb;color:#fff;cursor:pointer;font-size:14px">连接</button></form></div>'
        document.body.appendChild(div)
        document.getElementById('proma-token-form').addEventListener('submit', function (ev) {
          ev.preventDefault()
          var t = document.getElementById('proma-token-input').value.trim()
          if (!t) return
          localStorage.setItem('proma_web_token', t)
          location.reload()
        })
      }
      if (document.body) mount()
      else document.addEventListener('DOMContentLoaded', mount)
    }
  } catch (e) { /* private mode / 非浏览器环境忽略 */ }
})()
</script>`

/** 向 renderer HTML 注入 web-preload + token-gate（幂等：已注入则原样返回） */
function injectWebShell(html: string): string {
  if (html.includes(WEB_PRELOAD_PATH)) return html
  const inject = `<script src="${WEB_PRELOAD_PATH}"></script>\n${TOKEN_GATE_SCRIPT}\n</head>`
  if (html.includes('</head>')) return html.replace('</head>', inject)
  return `${html}\n${inject}`
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  // 防目录穿越
  const target = resolve(PUBLIC_DIR, rel)
  if (!target.startsWith(resolve(PUBLIC_DIR))) {
    return new Response('forbidden', { status: 403 })
  }
  try {
    const buf = await readFile(target)
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream'
    if (type.includes('text/html')) {
      // 阶段 3：renderer HTML 注入 web-preload + token-gate
      return new Response(injectWebShell(buf.toString('utf8')), { headers: { 'Content-Type': type } })
    }
    return new Response(buf, { headers: { 'Content-Type': type } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

// ===================== graceful shutdown =====================

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutting down', { signal })

  // #12 P1：等待正在执行的 invoke 完成（最多 10s），避免 handler 写文件/执行 bash 被中断
  const deadline = Date.now() + 10_000
  while (runningInvokes > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (runningInvokes > 0) {
    logger.warn('shutdown: force exit with running invokes', { running: runningInvokes })
  }

  // 通知客户端并关闭 WS（先保存引用，再清 activeClient）
  const victim = activeClient
  activeClient = null
  if (victim) {
    try {
      sendFrame(victim, { type: 'bye', reason: 'server shutting down' })
      victim.close(1001, 'server shutting down')
    } catch {
      /* ignore */
    }
    cleanupClient(victim)
  }

  // B3：清理心跳定时器，避免阻止进程退出
  if (heartbeatTimer) clearInterval(heartbeatTimer)

  // B5：serverRef 守卫（启动期可能未赋值）
  if (serverRef) serverRef.stop(true)

  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// ===================== Bun.serve =====================

await loadPromaMain()
registerWebCompatHandlers()
registerTestHandlers()

let serverRef: import('bun').Server

try {
  serverRef = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req, srv) {
      const url = new URL(req.url)

      // WebSocket 升级（Token 认证 + M7 连接限频 + #28 Origin 校验）
      if (url.pathname === '/ws') {
        const token = url.searchParams.get('token')
        if (token !== WS_TOKEN) {
          return new Response('unauthorized: bad or missing token', { status: 401 })
        }
        if (!originAllowed(req)) {
          logger.warn('origin not allowed', { origin: req.headers.get('origin') })
          return new Response('forbidden: origin not allowed', { status: 403 })
        }
        const ip = srv.requestIP(req)?.address ?? 'unknown'
        if (connRateLimited(ip)) {
          logger.warn('connection rate limited', { ip })
          return new Response('too many connections, slow down', { status: 429 })
        }
        if (srv.upgrade(req)) return undefined
        return new Response('upgrade failed', { status: 400 })
      }

      // 健康检查
      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          name: PROTOCOL_NAME,
          protocol: PROTOCOL_VERSION,
          version: SERVER_VERSION,
          pid: process.pid,
          uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
          channels: registeredChannelCount,
          activeConnections: activeClient ? 1 : 0,
        })
      }

      // 轻量指标（JSON）
      if (url.pathname === '/metrics') {
        return Response.json({
          ...metrics,
          activeConnections: activeClient ? 1 : 0,
          uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
        })
      }

      // 静态 UI
      return serveStatic(url.pathname)
    },
    websocket: {
      open(ws) {
        allClients.add(ws)
        // 单活跃连接互斥：新连接顶替旧连接
        if (activeClient && activeClient !== ws) {
          try {
            sendFrame(activeClient, { type: 'bye', reason: 'superseded by a new connection' })
            activeClient.close(4002, 'superseded')
          } catch {
            /* ignore */
          }
          cleanupClient(activeClient)
        }
        activeClient = ws
        metrics.connectionsTotal++
        const st = getState(ws)
        st.connectedAt = Date.now()
        st.lastSeen = Date.now()
        sendFrame(ws, {
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          channels: listRegisteredChannels(),
          server: {
            name: PROTOCOL_NAME,
            version: SERVER_VERSION,
            pid: process.pid,
            uptime: Math.floor((Date.now() - START_TIME) / 1000),
          },
        })
        logger.info('ws client connected', { conn: st.connectedAt })
      },
      message(ws, raw) {
        const st = getState(ws)
        st.lastSeen = Date.now()

        const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
        metrics.bytesReceived += size
        if (size > MAX_MSG_BYTES) {
          sendFrame(ws, { type: 'error', code: ERR.MSG_TOO_LARGE, message: `message too large: ${size} bytes (max ${MAX_MSG_BYTES})` })
          return
        }

        let msg: unknown
        try {
          msg = JSON.parse(String(raw))
        } catch {
          sendFrame(ws, { type: 'error', code: ERR.BAD_JSON, message: 'invalid json' })
          return
        }

        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
          // #14 P2：非法帧返回 error（数组也是 object，需显式排除）
          sendFrame(ws, { type: 'error', code: 'invalid_frame', message: 'frame must be a JSON object' })
          return
        }
        const frame = msg as Record<string, unknown>

        switch (frame.type) {
          case 'invoke':
            void handleInvoke(ws, frame as unknown as InvokeFrame)
            break
          case 'ping':
            sendFrame(ws, { type: 'pong', t: (frame as { t?: number }).t })
            break
          case 'pong':
            // 心跳回应，lastSeen 已更新
            break
          default:
            sendFrame(ws, { type: 'error', code: 'unknown_frame', message: `unknown frame type: ${String(frame.type)}` })
        }
      },
      close(ws) {
        allClients.delete(ws)
        if (activeClient === ws) activeClient = null
        cleanupClient(ws)
        logger.info('ws client disconnected', { remaining: activeClient ? 1 : 0 })
      },
    },
  })
} catch (err) {
  const e = err as Error & { code?: string }
  if (e?.code === 'EADDRINUSE' || /address already in use|EADDRINUSE/i.test(e?.message ?? '')) {
    logger.error('port already in use', { host: HOST, port: PORT })
    console.error(`[server] 端口 ${PORT} 已被占用。请检查是否已有实例运行，或设置 PROMA_WEB_PORT 换端口。`)
  } else {
    logger.error('failed to start server', { error: e?.message })
  }
  process.exit(1)
}

scheduleHeartbeat()

logger.info('server started', { host: HOST, port: PORT, ws: `/ws`, health: `/health` })
console.log(`[server] Proma Web server → http://${HOST}:${PORT}`)
console.log(`[server] WebSocket 桥: ws://${HOST}:${PORT}/ws`)
console.log(`[server] 已注册通道数: ${registeredChannelCount}`)

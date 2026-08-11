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

// ===================== 移动端 UA 检测（阶段 4：renderer 移动端适配） =====================
//
// 两层检测：
//  1. 服务端 detectMobileUA(ua) 解析 User-Agent 头，决定注入哪些内容（viewport meta / CSS）
//  2. 客户端 MOBILE_DETECT_SCRIPT 在页面加载时细判（含 iPadOS 13+ UA 伪装 Mac 的场景），
//     设置 window.__PROMA_MOBILE__ 供 React renderer 使用，并在 <html> 加 CSS 类

interface MobileInfo {
  isMobile: boolean
  isPhone: boolean
  isTablet: boolean
  isTouch: boolean
  isIOS: boolean
  isAndroid: boolean
  ua: string
}

/** 服务端 UA 预判（粗略：没有 maxTouchPoints，iPadOS 伪装 Mac 只能靠客户端补判） */
function detectMobileUA(uaStr: string | null): MobileInfo {
  const u = uaStr || ''
  const isIOS = /iPhone|iPad|iPod/i.test(u)
  const isAndroid = /Android/i.test(u)
  const isWindowsPhone = /Windows Phone/i.test(u)
  const isTablet = /iPad|Tablet|Silk/i.test(u) || (isAndroid && !/Mobile/i.test(u))
  const isPhone =
    /iPhone|iPod/i.test(u) ||
    (isAndroid && /Mobile/i.test(u)) ||
    isWindowsPhone ||
    /Mobile|Opera Mini|UCWEB|IEMobile/i.test(u)
  return {
    isMobile: isPhone || isTablet,
    isPhone,
    isTablet,
    isTouch: false, // 服务端无法可靠判断触屏，由客户端脚本补判
    isIOS,
    isAndroid,
    ua: u,
  }
}

/** 移动端 viewport meta（若目标 HTML 缺省才注入；viewport-fit=cover 适配刘海屏） */
const MOBILE_VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />'

/** Web 壳层基础 CSS（无条件注入）：Web 版无 Electron 窗口，窗口控制按钮调用 stub no-op，全局隐藏 */
const WEB_SHELL_CSS = `<style>
/* Web 版无 Electron 窗口控制能力，最小化/最大化/关闭按钮为 stub no-op，隐藏 */
.window-controls { display: none !important; }
</style>`

/** 移动端基础 CSS（防双击缩放/点击高亮/横向滚动，为后续全屏适配打底） */
const MOBILE_CSS = `<style>
html.is-mobile { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
html.is-mobile body { overscroll-behavior-y: contain; }
html.is-mobile ::-webkit-scrollbar { -webkit-appearance: none; width: 0; height: 0; }

/* ── 手机专属（is-phone）：隐藏按钮 / 消息区占满 / 输入框缩小 / 设置两页式 ── */
/* 隐藏 TabBar 右侧 FAQ+快捷键地图按钮（ShortcutGuideButton）：
   Windows 分支 class 含 items-center、非 Windows 分支含 items-end，用 gap-1 同时覆盖两分支。
   （原 items-center 选择器在真实手机 navigator.platform 非 Windows 时不生效，用户截图中该按钮仍可见） */
html.is-phone .main-tabbar div.titlebar-no-drag.gap-1 { display: none !important; }
/* 隐藏草稿 tab（Scratch Pad 固定入口，外层仅此处为 titlebar-no-drag + flex-shrink-0） */
html.is-phone .main-tabbar div.titlebar-no-drag.flex-shrink-0 { display: none !important; }

/* 消息区占满屏宽：取消 pl-[46px] 头像对齐缩进（user/assistant 消息、操作按钮、分隔线、TurnFileChanges 等消息相关元素统一靠左），
   并将聊天/Agent 视图内容容器 max-width 放开为 100%（桌面 72rem 居中限制在手机竖屏下取消） */
html.is-phone [class*="pl-[46px]"] { padding-left: 0 !important; }
html.is-phone [class*="max-w-[min(72rem"] { max-width: 100% !important; }

/* 输入框缩小：placeholder 三行提示改为单行省略（无法直接改 React 属性，用 !important 覆盖内嵌 style 的 attr(data-placeholder)），
   并减小 ProseMirror 内容最小高度，显著压缩输入框占屏高度 */
html.is-phone .rich-text-input .ProseMirror p.is-editor-empty:first-child::before {
  content: '输入消息…' !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  max-width: 100% !important;
}
html.is-phone .rich-text-input .ProseMirror { min-height: 48px !important; }

/* 左右侧边栏默认收起：由 head 内联脚本（MOBILE_DETECT_SCRIPT is-phone 分支）预置 localStorage（atomWithStorage 启动读取），用户可再展开 */

/* 消息列表左右边距：conversation 容器 px-8(32px) 缩到 8px，消息气泡 px-2.5(10px) 缩到 4px */
html.is-phone [class*="py-4"][class*="px-8"] { padding-left: 8px !important; padding-right: 8px !important; }
html.is-phone .message-item { padding-left: 4px !important; padding-right: 4px !important; }

/* 设置面板两页式：目录页全宽导航；点项后内容区全屏覆盖（手机可读可用） */
html.is-phone.proma-settings-nav .settings-left-nav { display: flex; width: 100%; max-width: 100%; flex: 1 1 auto; }
html.is-phone.proma-settings-nav .settings-right-body { display: none !important; }
html.is-phone.proma-settings-content .settings-left-nav { display: none !important; }
html.is-phone.proma-settings-content .settings-right-body { display: block; width: 100%; max-width: 100%; }
html.is-phone.proma-settings-content .proma-settings-back { display: flex !important; }

/* ── 任务 1：Todo 快速创建弹窗（及其他 Dialog）手机端收窄，避免全屏宽遮住内容 ── */
html.is-phone [role="dialog"] {
  width: calc(100% - 24px) !important;
  max-width: 380px !important;
}
/* 弹窗底部操作按钮行在小屏不换行挤压：允许横向滚动/收缩 */
html.is-phone [role="dialog"] .flex.flex-wrap { flex-wrap: nowrap !important; }
/* 注入的关闭按钮（proma-dialog-close）样式 */
button.proma-dialog-close {
  position: absolute !important;
  right: 8px !important;
  top: 8px !important;
  z-index: 20 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 32px !important;
  height: 32px !important;
  border-radius: 8px !important;
  border: 1px solid rgba(255,255,255,.12) !important;
  background: rgba(30,30,40,.72) !important;
  color: #e5e7eb !important;
  font-size: 16px !important;
  line-height: 1 !important;
  cursor: pointer !important;
  backdrop-filter: blur(4px) !important;
  -webkit-tap-highlight-color: transparent !important;
}

/* ── 任务 2：Agent 技能视图工具条手机端优化（Skills/MCP/记忆 tab + 搜索框不拥挤） ── */
html.is-phone [class*="max-w-6xl"][class*="gap-3"] {
  flex-wrap: wrap !important;
  gap: 4px 6px !important;
  padding-left: 8px !important;
  padding-right: 8px !important;
}
html.is-phone [class*="max-w-6xl"][class*="gap-3"] [class*="min-w-[96px]"] {
  min-width: 64px !important;
  padding-left: 6px !important;
  padding-right: 6px !important;
  font-size: 13px !important;
}
html.is-phone [class*="max-w-6xl"][class*="gap-3"] [class*="min-w-[96px]"] span {
  font-size: 11px !important;
}
/* 搜索框在手机端占满剩余宽度，避免被右侧按钮压成 0 */
html.is-phone [class*="max-w-6xl"][class*="gap-3"] > div.flex-1 {
  min-width: 120px !important;
  flex: 1 1 120px !important;
}
/* 工具条右侧次要按钮（社区市场 / AI 分类 / 导入）缩小 */
html.is-phone [class*="max-w-6xl"][class*="gap-3"] button.h-8 {
  font-size: 12px !important;
  padding-left: 8px !important;
  padding-right: 8px !important;
}
/* 侧栏展开态 SkillsSidebarEntry 计数徽标稍放大，文字间距更清晰 */
html.is-phone [aria-label^="Agent 技能"] .flex.h-5 {
  height: 20px !important;
  min-width: 26px !important;
  font-size: 12px !important;
}
html.is-phone [aria-label^="Agent 技能"] .truncate {
  font-size: 13.5px !important;
}

/* ── 任务 4b：模型选择器按钮手机端缩小（Agent + Chat 统一） ── */
html.is-phone .model-selector-trigger {
  max-width: 148px !important;
  padding-left: 6px !important;
  padding-right: 6px !important;
  font-size: 11px !important;
}
html.is-phone .model-selector-trigger > span {
  max-width: 96px !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
</style>`

/** 手机端 UI 增强脚本：设置两页式 + 侧栏默认收起兜底（挂在 is-phone 下） */
const MOBILE_UI_SCRIPT = `
<script>
// Proma Web mobile-ui（server 注入）：手机端 UI 适配
//  - 设置面板两页式：目录页 → 内容页（返回按钮回目录）
//  - 左右侧边栏默认收起由 head 内联脚本预置 localStorage；这里只处理动态兜底
(function () {
  try {
    var isPhone = !!(window.__PROMA_MOBILE__ && window.__PROMA_MOBILE__.isPhone)
    if (!isPhone) return

    var settingsBackBtn = null
    var lastSettingsVisible = false

    function setSettingsMode(mode) {
      var html = document.documentElement
      html.classList.remove('proma-settings-nav', 'proma-settings-content')
      html.classList.add(mode === 'content' ? 'proma-settings-content' : 'proma-settings-nav')
    }

    function ensureSettingsBackBtn() {
      if (settingsBackBtn && document.body.contains(settingsBackBtn)) return
      settingsBackBtn = document.createElement('button')
      settingsBackBtn.className = 'proma-settings-back'
      settingsBackBtn.textContent = '‹ 目录'
      settingsBackBtn.setAttribute('aria-label', '返回设置目录')
      settingsBackBtn.style.cssText =
        'display:none;position:fixed;top:4px;left:8px;z-index:1000;align-items:center;height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(30,30,40,.85);color:#e5e7eb;font:13px system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(4px)'
      settingsBackBtn.addEventListener('click', function () {
        setSettingsMode('nav')
      })
      document.body.appendChild(settingsBackBtn)
    }

    // 给设置面板打结构标记（幂等）：左侧导航 / 右侧内容
    // 注意：w-[277px] 含方括号，CSS 选择器必须用属性包含 [class*=] 避免转义层问题
    function markPanel(panel) {
      var nav = panel.querySelector('[class*="277px"]')
      if (nav && !nav.classList.contains('settings-left-nav')) {
        nav.classList.add('settings-left-nav')
      }
      var body = panel.querySelector('.min-w-0.flex-1')
      if (body && !body.classList.contains('settings-right-body')) {
        body.classList.add('settings-right-body')
      }
    }

    function querySettingsPanel() {
      var panels = document.querySelectorAll('.absolute.inset-0 > .flex.h-full.min-h-0.flex-col')
      return panels.length > 0 ? panels[panels.length - 1] : null
    }

    function checkSettings() {
      var panel = querySettingsPanel()
      var visible = !!panel
      if (visible) {
        markPanel(panel)
        if (!lastSettingsVisible) {
          // 设置面板“从无到有”：重置为目录页（React 渲染期间不重复重置）
          setSettingsMode('nav')
          ensureSettingsBackBtn()
        }
      } else {
        // 面板已关闭：清理状态，下次打开重新回目录页
        if (lastSettingsVisible) {
          document.documentElement.classList.remove('proma-settings-nav', 'proma-settings-content')
        }
      }
      lastSettingsVisible = visible
      // 追加注入任务（与设置面板同周期检测，确保 React 重渲染后仍生效）：
      //  - Todo 弹窗等无关闭按钮的 Dialog 注入 X 关闭按钮
      //  - 窄屏被折叠进「更多工具」的上传入口，注入常驻 Paperclip 按钮
      var dlg = document.querySelector('[role="dialog"]')
      if (dlg) ensureDialogCloseButton(dlg)
      ensureAttachButton()
    }

    // 事件委托：点击设置导航项 → 切到内容页
    document.addEventListener('click', function (ev) {
      var t = ev.target
      if (!t || !t.closest) return
      if (t.closest('.settings-left-nav nav button')) {
        setSettingsMode('content')
      }
    }, true)

    var mo = new MutationObserver(checkSettings)
    mo.observe(document.documentElement, { childList: true, subtree: true })
    checkSettings()

    // ── 任务 1：Todo 快速创建弹窗（及无关闭按钮的 Dialog）注入 X 关闭按钮 ──
    // 桌面版 Todo 新建弹窗使用 hideClose（无关闭按钮，靠 Esc/遮罩关闭）；手机端用户找不到关闭入口。
    // 注入一个右上角 X：点击后模拟 Esc 让 Radix Dialog 正常关闭。
    var dialogCloseInjected = new WeakSet()
    function ensureDialogCloseButton(dialog) {
      if (dialogCloseInjected.has(dialog)) return
      var hasCloseBtn = dialog.querySelector('button[aria-label="Close"], button[aria-label="关闭"], .proma-dialog-close')
      if (hasCloseBtn) return
      var close = document.createElement('button')
      close.type = 'button'
      close.className = 'proma-dialog-close'
      close.setAttribute('aria-label', '关闭')
      close.innerHTML = '✕'
      close.addEventListener('click', function (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        // 模拟 Esc：Radix Dialog 默认监听 Escape 关闭
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      })
      // 放到 dialog 内右上角（Radix dialog 是相对定位的容器）
      dialog.style.position = 'relative'
      dialog.appendChild(close)
      dialogCloseInjected.add(dialog)
    }

    // ── 任务 3：新会话只开一个，不重复制造无意义空会话 ──
    // 桌面逻辑：每次点“新会话/新对话”都无条件 createAgentSession/createChat，导致大量“新 Agent 会话”空会话堆积。
    // 注入层拦截：若当前激活 Tab 已是空白会话（标题为“新 Agent 会话”/“新对话”且无消息），则阻止新建，
    // 只聚焦当前空白会话。仅手机端启用（桌面用户可能依赖快捷键连续新建）。
    var lastBlankToast = 0
    function isBlankSessionTab() {
      var active = document.querySelector('.app-tab-active')
      if (!active) return false
      var text = (active.textContent || '').trim()
      return /^新 Agent 会话/.test(text) || /^新对话/.test(text)
    }
    function showBlankToast() {
      var now = Date.now()
      if (now - lastBlankToast < 2500) return
      lastBlankToast = now
      var toast = document.createElement('div')
      toast.textContent = '已在空白会话中，直接输入即可'
      toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);z-index:99999;background:#1f2937;color:#e5e7eb;padding:8px 14px;border-radius:10px;border:1px solid #4b5563;font:12px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.35);max-width:80%;text-align:center;pointer-events:none;opacity:0;transition:opacity .2s'
      document.body.appendChild(toast)
      requestAnimationFrame(function () { toast.style.opacity = '1' })
      setTimeout(function () { toast.style.opacity = '0'; setTimeout(function () { toast.remove() }, 250) }, 1800)
    }
    document.addEventListener('click', function (ev) {
      var t = ev.target
      if (!t || !t.closest) return
      // 命中“新会话/新对话”按钮：rail（aria-label）或展开态（文本“+ 新会话”等）
      var btn = t.closest('button')
      if (!btn) return
      var aria = (btn.getAttribute('aria-label') || '') + (btn.getAttribute('title') || '')
      var text = (btn.textContent || '').trim().replace(/\s+/g, ' ')
      var isNewSessionBtn = /新建 Agent 会话|新建 Chat 对话/.test(aria) || /^[+＋]?\s*(新会话|新对话|新建会话|新建对话)$/.test(text) || /^新会话$|^新对话$/.test(text)
      if (!isNewSessionBtn) return
      if (isBlankSessionTab()) {
        ev.preventDefault()
        ev.stopPropagation()
        ev.stopImmediatePropagation()
        showBlankToast()
      }
    }, true)

    // Dialog 出现时注入关闭按钮：由 checkSettings 内的 ensureDialogCloseButton/ensureAttachButton 处理
    // （MutationObserver 回调即 checkSettings，直接包含注入逻辑，避免函数引用过期）

    // ── 任务 5：折叠侧栏（rail）长按弹出操作菜单 ──
    // 长按 rail 按钮 → 临时展开侧栏 → 匹配会话 → 派发 contextmenu → 重新折叠
    (function () {
      var LONG_PRESS_MS = 500
      var MOVE_THRESHOLD = 10
      var timer = null
      var startX = 0, startY = 0
      var targetBtn = null
      var menuActive = false
      var sidebarWasCollapsed = false
      var collapseTimer = null

      function getSessionTitle(btn) {
        var label = (btn.getAttribute('aria-label') || '').trim()
        var m = label.match(/打开(?:Agent 会话|Chat 对话)[：:]\s*(.+)/)
        return m ? m[1].trim() : ''
      }

      function isSidebarCollapsed() {
        var navs = document.querySelectorAll('nav')
        for (var i = 0; i < navs.length; i++) {
          var aside = navs[i].querySelector('aside, > div:first-child, > div.flex.flex-col')
          if (aside) {
            var w = aside.getBoundingClientRect().width
            if (w > 0 && w < 100) return true
          }
        }
        try { return localStorage.getItem('proma-sidebar-collapsed') === 'true' } catch (e) { return false }
      }

      function expandSidebar() {
        var btn = document.querySelector('[aria-label="展开侧边栏"]')
        if (btn) { btn.click(); return true }
        return false
      }

      function collapseSidebar() {
        var btn = document.querySelector('[aria-label="折叠侧边栏"]')
        if (btn) { btn.click(); return true }
        return false
      }

      function findSessionElement(title) {
        if (!title) return null
        // 1. Chat 会话：data-session-switch-title
        var items = document.querySelectorAll('[data-session-switch-title]')
        for (var i = 0; i < items.length; i++) {
          if (items[i].getAttribute('data-session-switch-title') === title) return items[i]
        }
        // 2. Agent 会话：data-session-switch-id + 文本匹配
        var idItems = document.querySelectorAll('[data-session-switch-id]')
        for (var j = 0; j < idItems.length; j++) {
          var text = (idItems[j].textContent || '').replace(/\s+/g, ' ').trim()
          if (text.indexOf(title) !== -1) return idItems[j]
        }
        return null
      }

      function dispatchAction(el) {
        menuActive = true
        // Chat 会话：派发 contextmenu → Radix ContextMenu
        var ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        el.dispatchEvent(ev)
        // Agent 会话兜底：100ms 后若无菜单出现，点击 ⋯ 按钮触发 DropdownMenu
        setTimeout(function () {
          if (!menuActive) return
          var portal = document.querySelector('[data-radix-popper-content-wrapper]')
          if (!portal) {
            var parent = el.parentElement
            if (parent) {
              var moreBtn = parent.querySelector('button')
              if (moreBtn) moreBtn.click()
            }
          }
        }, 100)
      }

      function scheduleReCollapse() {
        if (collapseTimer) clearTimeout(collapseTimer)
        function checkAndCollapse() {
          var portal = document.querySelector('[data-radix-popper-content-wrapper]')
          if (!portal && menuActive) {
            menuActive = false
            if (sidebarWasCollapsed) collapseSidebar()
            document.removeEventListener('click', onGlobalClick, true)
            document.removeEventListener('mousedown', onGlobalClick, true)
            collapseTimer = null
          } else if (portal) {
            collapseTimer = setTimeout(checkAndCollapse, 500)
          }
        }
        function onGlobalClick() {
          setTimeout(checkAndCollapse, 400)
        }
        document.addEventListener('click', onGlobalClick, true)
        document.addEventListener('mousedown', onGlobalClick, true)
        // 10s 兜底强制折叠
        setTimeout(function () {
          if (menuActive) { menuActive = false; if (sidebarWasCollapsed) collapseSidebar() }
        }, 10000)
      }

      function handleLongPress(btn) {
        var title = getSessionTitle(btn)
        if (!title) return
        sidebarWasCollapsed = isSidebarCollapsed()

        function doFindAndPopup() {
          var el = findSessionElement(title)
          if (el) { dispatchAction(el); scheduleReCollapse(); return true }
          return false
        }

        if (sidebarWasCollapsed) {
          if (!expandSidebar()) return
          setTimeout(function () {
            if (!doFindAndPopup()) {
              var tries = 0
              var retry = setInterval(function () {
                tries++
                if (doFindAndPopup()) clearInterval(retry)
                else if (tries >= 8) { clearInterval(retry); collapseSidebar() }
              }, 250)
            }
          }, 400)
        } else {
          doFindAndPopup()
        }
      }

      function cancelLongPress() {
        if (timer) { clearTimeout(timer); timer = null }
        targetBtn = null
      }

      document.addEventListener('touchstart', function (ev) {
        for (var el = ev.target; el && el !== document.body; el = el.parentElement) {
          if (el.tagName === 'BUTTON' && (el.getAttribute('aria-label') || '').indexOf('打开') === 0) {
            targetBtn = el
            break
          }
        }
        if (!targetBtn) return
        var t = ev.touches[0]
        startX = t.clientX; startY = t.clientY
        timer = setTimeout(function () {
          timer = null
          var btn = targetBtn; targetBtn = null
          if (btn) handleLongPress(btn)
        }, LONG_PRESS_MS)
      }, { passive: false })

      document.addEventListener('touchmove', function (ev) {
        if (!timer || !targetBtn) return
        var t = ev.touches[0]
        if (Math.abs(t.clientX - startX) > MOVE_THRESHOLD || Math.abs(t.clientY - startY) > MOVE_THRESHOLD) {
          cancelLongPress()
        }
      }, { passive: false })

      document.addEventListener('touchend', cancelLongPress)
      document.addEventListener('touchcancel', cancelLongPress)
    })()

    window.__PROMA_MOBILE_UI__ = { setSettingsMode: setSettingsMode, observer: mo }
    // Chat 输入工具栏使用 InputToolbarOverflow：窄屏时按钮按尾部优先折叠进「更多工具」
    // （含 Paperclip 附件按钮），用户找不到上传入口。
    // 方案：在工具栏主行注入一个常驻 Paperclip 按钮；点击时自动展开「更多」并触发其中的附件按钮，
    // 走原 React 流程（handleOpenFileDialog → openFileDialog → input[type=file].click()）。
    var attachBtnInjected = false
    function ensureAttachButton() {
      // 若上次注入的按钮仍在 DOM 中则无需处理；否则允许重注入（React 重渲染可能移除注入节点）
      if (document.querySelector('.proma-attach-fab')) { attachBtnInjected = true; return }
      attachBtnInjected = false
      // 已存在可见的附件按钮（Agent 模式未折叠时 aria="附加文件或文件夹"）则跳过
      var existing = Array.from(document.querySelectorAll('button')).filter(function (b) {
        var r = b.getBoundingClientRect()
        var a = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')
        return r.width > 0 && r.height > 0 && r.y > 780 && /附加文件|添加附件/.test(a)
      })
      if (existing.length > 0) return
      var moreBtn = Array.from(document.querySelectorAll('button')).find(function (b) {
        var r = b.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.y > 780 && (b.getAttribute('aria-label') || '') === '更多工具'
      })
      if (!moreBtn) return
      var toolbarRow = moreBtn.parentElement
      if (!toolbarRow) return
      // 避免重复注入
      if (toolbarRow.querySelector('.proma-attach-fab')) return
      var fab = document.createElement('button')
      fab.type = 'button'
      fab.className = 'proma-attach-fab'
      fab.setAttribute('aria-label', '添加文件')
      fab.title = '添加文件'
      fab.innerHTML = '📎'
      fab.style.cssText = 'display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#9ca3af;font-size:15px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent'
      fab.addEventListener('click', function () {
        // 打开「更多工具」popover
        var more = Array.from(document.querySelectorAll('button')).find(function (b) {
          return (b.getAttribute('aria-label') || '') === '更多工具'
        })
        if (!more) return
        more.click()
        // 等待 popover 渲染后点击其中的附件按钮（带 Paperclip svg / 无 aria 的第 2 个按钮）
        setTimeout(function () {
          var dlg = document.querySelector('[role="dialog"]')
          if (!dlg) return
          var btns = Array.from(dlg.querySelectorAll('button'))
          // 优先找带 Paperclip svg 的按钮；否则取第 2 个（thinking, attach, speech...）
          var target = btns.find(function (b) { return !!b.querySelector('svg.lucide-paperclip') }) || btns[1]
          if (target) target.click()
        }, 120)
      })
      toolbarRow.insertBefore(fab, moreBtn)
      attachBtnInjected = true
    }

    window.__PROMA_MOBILE_UI__ = { setSettingsMode: setSettingsMode, observer: mo }
  } catch (e) { /* ignore */ }
})()
</script>`

/** 客户端细判脚本：与 token-gate 同模式，注入到 </head> 前 */
const MOBILE_DETECT_SCRIPT = `
<script>
// Proma Web mobile-detect（server 注入）：细判移动端/触屏，暴露 __PROMA_MOBILE__
(function () {
  try {
    var ua = navigator.userAgent || ''
    var maxTouch = (navigator.maxTouchPoints || 0) > 0
    // iPadOS 13+ Safari 桌面 UA（MacIntel）+ 触屏 → 视为 iPad
    var isIOS =
      /iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh|MacIntel/i.test(ua) && maxTouch && /Safari/i.test(ua))
    var isAndroid = /Android/i.test(ua)
    var isTablet =
      /iPad|Tablet|Silk/i.test(ua) ||
      (isAndroid && !/Mobile/i.test(ua)) ||
      (isIOS && !/iPhone|iPod/i.test(ua))
    var isPhone =
      /iPhone|iPod/i.test(ua) ||
      (isAndroid && /Mobile/i.test(ua)) ||
      /Windows Phone|IEMobile|Opera Mini|UCWEB/i.test(ua)
    var info = {
      isMobile: isPhone || isTablet,
      isPhone: isPhone,
      isTablet: isTablet,
      isTouch: maxTouch,
      isIOS: isIOS,
      isAndroid: isAndroid,
      ua: ua,
    }
    window.__PROMA_MOBILE__ = info
    var doc = document.documentElement
    if (info.isMobile) doc.classList.add('is-mobile')
    if (info.isPhone) doc.classList.add('is-phone')
    if (info.isTablet) doc.classList.add('is-tablet')
    if (info.isTouch) doc.classList.add('is-touch')
    if (info.isIOS) doc.classList.add('is-ios')
    if (info.isAndroid) doc.classList.add('is-android')
    if (info.isPhone) {
      // 手机默认收起左右侧边栏（仅用户从未设置过时预置，尊重已保存偏好）：
      //  - proma-sidebar-collapsed=true：左侧边栏收起为 ~60px 折叠 rail，用户可点展开
      //  - proma-agent-sidepanel-open=false：右侧文件面板默认关闭
      // 本脚本注入在 </head> 前（早于 React bundle / atomWithStorage 初始化），
      // 首次访问手机时即可生效；桌面 UA 不会执行此分支，不预置任何值。
      try {
        if (localStorage.getItem('proma-sidebar-collapsed') === null) {
          localStorage.setItem('proma-sidebar-collapsed', 'true')
        }
        if (localStorage.getItem('proma-agent-sidepanel-open') === null) {
          localStorage.setItem('proma-agent-sidepanel-open', 'false')
        }
      } catch (e) { /* localStorage 不可用时忽略 */ }
    }
    if (info.isMobile) {
      // 长按图片/链接时禁止系统菜单（原生 contextmenu 事件仍可触发自定义菜单）
      document.addEventListener('contextmenu', function (ev) {
        ev.preventDefault()
      }, true)
    }
  } catch (e) { /* 非浏览器环境忽略 */ }
})()
</script>`

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

/** 向 renderer HTML 注入 web-preload + token-gate + mobile-detect + mobile-ui（幂等：已注入则原样返回） */
function injectWebShell(html: string, mobile?: MobileInfo): string {
  if (html.includes(WEB_PRELOAD_PATH)) return html
  const mobileMeta = mobile?.isMobile && !html.includes('name="viewport"') ? MOBILE_VIEWPORT_META + '\n' : ''
  const mobileCss = mobile?.isMobile ? MOBILE_CSS + '\n' : ''
  const mobileUi = mobile?.isMobile ? MOBILE_UI_SCRIPT + '\n' : ''
  const inject =
    `<script src="${WEB_PRELOAD_PATH}"></script>\n${TOKEN_GATE_SCRIPT}\n${MOBILE_DETECT_SCRIPT}\n${mobileUi}</head>`
  // WEB_SHELL_CSS 无条件注入（窗口控件在 Web 版一律隐藏）；其余移动端增强仅手机/移动注入
  const headInject = WEB_SHELL_CSS + '\n' + mobileMeta + mobileCss + inject
  if (html.includes('</head>')) return html.replace('</head>', headInject)
  return `${html}\n${headInject}`
}

async function serveStatic(pathname: string, mobile?: MobileInfo): Promise<Response> {
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
      // 阶段 3：renderer HTML 注入 web-preload + token-gate；阶段 4：移动端 viewport/CSS/检测
      return new Response(injectWebShell(buf.toString('utf8'), mobile), { headers: { 'Content-Type': type } })
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

// ===================== 异常兜底（防 ws 包崩溃） =====================
//
// doubao-asr-service 使用 `ws` 包连豆包 wss。Bun 1.3.14 下 ws 包在连接失败
// （如凭证错误/网络不通）时会二次 emit error 且无监听器，抛 ERR_UNHANDLED_ERROR，
// 直接炸掉整个 Bun 进程——表现就是用户一点语音输入/测试连接，Web 服务整体不可用。
// 这里兜底：捕获这类二次 error 崩溃，记录日志但不退出（会话错误由 handler 层自行收尾）。
const WS_CRASH_PATTERN = /Unhandled error\.\s*\(ErrorEvent|\(ErrorEvent \{/i
process.on('uncaughtException', (err) => {
  const message = err instanceof Error ? err.message : String(err)
  if (WS_CRASH_PATTERN.test(message) || /isTrusted:\s*\[Getter\]/i.test(message)) {
    logger.warn('ws error event crashed the process (guarded)', { message: message.slice(0, 200) })
    return
  }
  logger.error('uncaughtException', { error: message.slice(0, 500) })
  console.error('[server] uncaughtException:', message)
})
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  logger.warn('unhandledRejection', { error: message.slice(0, 300) })
})

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

      // 静态 UI（服务端移动端预判：决定是否注入移动端 viewport/CSS）
      return serveStatic(url.pathname, detectMobileUA(req.headers.get('user-agent')))
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

/**
 * preload-bridge.ts — 浏览器端 WS IPC 桥（阶段 2）
 *
 * 在浏览器里替代 Electron 的 ipcRenderer / contextBridge / webUtils，
 * API 表面与 ipcRenderer 对齐，使生成的 web-preload 可以直接复用。
 *
 * 协议见 server-test/protocol.ts（request/event 两类通道）：
 *  - invoke:  {type:'invoke', id, channel, args} → {type:'result', id, ok, result|error}
 *  - 事件推送: {type:'event', channel, payload} → 分发到 on/once 注册的 listener
 *  - 心跳:    {type:'ping'} → 客户端回 {type:'pong'}
 *  - 握手:    {type:'ready', protocol, channels}
 *
 * 能力：
 *  - 自动重连（指数退避 1s→30s），断线时 pending invoke 全部 reject，listeners 保留
 *  - sendSync 兼容：浏览器无法真同步，返回缓存值（首次乐观 true），后台异步 invoke
 *  - 事件监听与 ipcRenderer 相同签名：(event, ...args)，event 为伪 IpcRendererEvent
 *  - 状态通知（#16）：onStatusChange 监听连接生命周期（no-token/connecting/connected/reconnecting/closed）
 *  - M2 懒连接：无 token 时不发起 WS 连接（由 token-gate 注入页负责引导输入 token 后刷新）
 */

/** 连接生命周期状态（#16） */
export type BridgeStatus = 'no-token' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export type StatusListener = (status: BridgeStatus, info?: { code?: number; reason?: string }) => void

/** 伪 IpcRendererEvent（对齐 Electron 回调签名第一个参数） */
export interface BridgeEvent {
  channel: string
  sender: unknown
  returnValue: unknown
}

type Listener = (event: BridgeEvent, ...args: unknown[]) => void

function resolveToken(): string {
  const cfg = (globalThis as any).__PROMA_WEB_CONFIG__ as { token?: string; wsUrl?: string } | undefined
  if (cfg?.token) return cfg.token
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('token')
  if (fromUrl) {
    try {
      globalThis.localStorage?.setItem('proma_web_token', fromUrl)
    } catch {
      /* private mode */
    }
    return fromUrl
  }
  try {
    return globalThis.localStorage?.getItem('proma_web_token') ?? ''
  } catch {
    return ''
  }
}

function resolveWsUrl(): string {
  const cfg = (globalThis as any).__PROMA_WEB_CONFIG__ as { wsUrl?: string } | undefined
  let base = cfg?.wsUrl
  if (!base && globalThis.location?.host) {
    const proto = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${globalThis.location.host}/ws`
  }
  if (!base) base = 'ws://127.0.0.1:6810/ws'
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(resolveToken())
}

class WSBridge {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()
  private onceListeners = new Map<string, Set<Listener>>()
  private syncCache = new Map<string, unknown>()
  private reconnectDelay = 1000
  private closedByUser = false
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null
  private readyPromise: Promise<void> = Promise.resolve()
  // #16：状态通知
  private statusListeners = new Set<StatusListener>()
  private currentStatus: BridgeStatus = 'closed'
  // M2：显式保存 token，无 token 时不连接
  private token: string

  /** 就绪 promise：每次连接重新创建（B1 修复：断线重连后 await ready 反映新连接状态） */
  get ready(): Promise<void> {
    return this.readyPromise
  }

  constructor(private url: string) {
    this.token = resolveToken()
    if (!this.token) {
      // M2 懒连接：无 token 不发起 WS（token-gate 注入页负责引导输入 token 后刷新）
      this.setStatus('no-token', { reason: 'missing token' })
      return
    }
    this.connect()
  }

  // ===================== 状态通知（#16） =====================

  /** 订阅连接状态变化，立即回调当前状态 */
  onStatusChange(fn: StatusListener): this {
    this.statusListeners.add(fn)
    try {
      fn(this.currentStatus)
    } catch (e) {
      console.error('[bridge] status listener error:', e)
    }
    return this
  }

  offStatusChange(fn: StatusListener): this {
    this.statusListeners.delete(fn)
    return this
  }

  private setStatus(status: BridgeStatus, info?: { code?: number; reason?: string }): void {
    this.currentStatus = status
    for (const fn of [...this.statusListeners]) {
      try {
        fn(status, info)
      } catch (e) {
        console.error('[bridge] status listener error:', e)
      }
    }
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res
      this.readyReject = rej
    })
  }

  // ===================== 连接管理 =====================

  private reconnectScheduled = false

  private connect(): void {
    if (this.closedByUser) return
    if (!this.token) {
      // M2：token 为空不连接（等待 token-gate 引导后刷新页面重新加载）
      this.setStatus('no-token', { reason: 'missing token' })
      return
    }
    // 防重入：已有 CONNECTING/OPEN 连接时不重复创建
    const st = this.ws?.readyState
    if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) return
    // B1 修复：每次连接重建 ready promise，重连后 await ready 等待新连接
    this.resetReady()
    this.setStatus(st === WebSocket.CLOSED || st === WebSocket.CLOSING ? 'reconnecting' : 'connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 1000
      this.setStatus('connected')
    }

    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      switch (msg?.type) {
        case 'ready':
          if (this.readyResolve) {
            this.readyResolve()
            this.readyResolve = null
          }
          break
        case 'result':
          this.settle(msg.id, msg)
          break
        case 'event':
          this.dispatch(msg.channel, msg.payload)
          break
        case 'ping':
          this.sendRaw({ type: 'pong', t: msg.t })
          break
        case 'bye':
        case 'error':
          // 协议级通知（被顶替/限流等），记录即可
          break
      }
    }

    ws.onclose = (ev) => {
      if (this.closedByUser) return
      // #7 修复：server 主动关闭
      if (ev.code === 1001 || ev.code === 4003) {
        // shutdown(1001) / 心跳超时(4003)：不再自动重连（等待页面刷新重新加载）
        this.closedByUser = true
        this.rejectAllPending(new Error(`ws closed by server (code ${ev.code})`))
        this.rejectReady(new Error(`ws closed by server (code ${ev.code})`))
        this.setStatus('closed', { code: ev.code, reason: 'closed by server' })
        return
      }
      if (ev.code === 4002) {
        // 被新连接顶替（单活跃连接互斥）：Web 多客户端场景下应自动重连恢复，
        // 而不是永久失效（否则用户在旧 tab 的操作全部本地失败）
        this.rejectAllPending(new Error('ws superseded by another connection, reconnecting…'))
        this.rejectReady(new Error('ws superseded by another connection, reconnecting…'))
        this.setStatus('reconnecting', { code: 4002, reason: 'superseded' })
        this.scheduleReconnect(5000)
        return
      }
      // 断线：reject 所有 pending + ready，保留 listeners
      this.rejectAllPending(new Error('ws disconnected, reconnecting…'))
      this.rejectReady(new Error('ws disconnected, reconnecting…'))
      this.setStatus('reconnecting', { code: ev.code, reason: 'disconnected' })
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  private rejectReady(err: Error): void {
    if (this.readyReject) {
      this.readyReject(err)
      this.readyReject = null
    }
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.closedByUser) return
    if (this.reconnectScheduled) return
    this.reconnectScheduled = true
    const delay = delayOverride ?? this.reconnectDelay
    setTimeout(() => {
      this.reconnectScheduled = false
      if (this.closedByUser) return
      this.connect()
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    }, delay)
  }

  /** 确保有连接在建立（invoke 前调用）；已连接/连接中则不动 */
  private ensureConnecting(): void {
    if (this.closedByUser || !this.token) return
    const st = this.ws?.readyState
    if (this.ws === null || st === WebSocket.CLOSED) {
      if (!this.reconnectScheduled) this.connect()
    }
  }

  private sendRaw(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  /** 主动关闭（页面卸载时调用） */
  dispose(): void {
    this.closedByUser = true
    // #6 修复：dispose 时 reject 未完成 invoke 与未就绪 ready
    this.rejectAllPending(new Error('bridge disposed'))
    this.rejectReady(new Error('bridge disposed'))
    this.setStatus('closed', { reason: 'disposed' })
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }

  // ===================== invoke =====================

  /** 裁剪末尾连续 undefined（JSON 无法表达 undefined，Electron IPC 可保留；
   * 末尾 undefined 等价"未传参"，裁剪后与原生行为对齐，避免参数校验把 undefined 当 null） */
  private trimUndefinedArgs(args: unknown[]): unknown[] {
    let end = args.length
    while (end > 0 && args[end - 1] === undefined) end--
    return args.slice(0, end)
  }

  /** 与 ipcRenderer.invoke 对齐：Promise 化调用；连接未就绪时自动重连并等待（最多 5s） */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextId++
    const trimmed = this.trimUndefinedArgs(args)
    return new Promise<unknown>((resolve, reject) => {
      const sendIfOpen = (): void => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.pending.set(id, { resolve, reject })
          this.sendRaw({ type: 'invoke', id, channel, args: trimmed })
          return true
        }
        return false
      }
      if (sendIfOpen()) return
      if (this.closedByUser) {
        reject(new Error(`[bridge] ws closed, cannot invoke ${channel}`))
        return
      }
      // 未连接：触发重连并轮询等待（最多 5s，覆盖页面刚加载/刚被顶替场景）
      this.ensureConnecting()
      const deadline = Date.now() + 5000
      const poll = (): void => {
        if (sendIfOpen()) return
        if (this.closedByUser || Date.now() > deadline) {
          reject(new Error(`[bridge] ws not ready, cannot invoke ${channel}`))
          return
        }
        this.ensureConnecting()
        setTimeout(poll, 200)
      }
      setTimeout(poll, 200)
    })
  }

  /** fire-and-forget（与 ipcRenderer.send 对齐）——B2 修复：不建 pending entry */
  send(channel: string, ...args: unknown[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const id = this.nextId++
      this.sendRaw({ type: 'invoke', id, channel, args: this.trimUndefinedArgs(args) })
      // 不建 pending（result 到达时 settle 找不到 entry 自然丢弃）
    }
  }

  /** sendSync 兼容：返回缓存值（首次乐观 true），后台异步 invoke 更新缓存 */
  sendSync(channel: string, ...args: unknown[]): unknown {
    this.invoke(channel, ...args)
      .then((v) => this.syncCache.set(channel, v))
      .catch(() => {})
    if (!this.syncCache.has(channel)) {
      // 首次调用：乐观返回 true（设置/草稿保存类语义，避免 renderer 走失败 fallback）
      return true
    }
    return this.syncCache.get(channel)
  }

  private settle(id: number | string, msg: { ok: boolean; result?: unknown; error?: string }): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'invoke failed'))
  }

  // ===================== 事件订阅（映射 WS addEventListener） =====================

  on(channel: string, fn: Listener): this {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel)!.add(fn)
    return this
  }

  once(channel: string, fn: Listener): this {
    if (!this.onceListeners.has(channel)) this.onceListeners.set(channel, new Set())
    this.onceListeners.get(channel)!.add(fn)
    return this
  }

  removeListener(channel: string, fn: Listener): this {
    this.listeners.get(channel)?.delete(fn)
    this.onceListeners.get(channel)?.delete(fn)
    return this
  }

  removeAllListeners(channel?: string): this {
    if (channel) {
      this.listeners.delete(channel)
      this.onceListeners.delete(channel)
    } else {
      this.listeners.clear()
      this.onceListeners.clear()
    }
    return this
  }

  private dispatch(channel: string, payload: unknown[]): void {
    const ev: BridgeEvent = { channel, sender: null, returnValue: undefined }
    const args = Array.isArray(payload) ? payload : [payload]
    const onceSet = this.onceListeners.get(channel)
    if (onceSet && onceSet.size > 0) {
      const toCall = [...onceSet]
      onceSet.clear()
      for (const fn of toCall) {
        try {
          fn(ev, ...args)
        } catch (e) {
          console.error('[bridge] once listener error:', e)
        }
      }
    }
    const set = this.listeners.get(channel)
    if (set && set.size > 0) {
      for (const fn of [...set]) {
        try {
          fn(ev, ...args)
        } catch (e) {
          console.error('[bridge] listener error:', e)
        }
      }
    }
  }
}

/** 对齐 electron 的 contextBridge（exposeInMainWorld → window 赋值） */
export const contextBridge = {
  exposeInMainWorld: (key: string, api: unknown): void => {
    ;(globalThis as any)[key] = api
  },
}

/** webUtils.getPathForFile：浏览器 File 对象无绝对路径；M3 修复：非 Chromium 降级返回 file.name */
export const webUtils = {
  getPathForFile: (file: unknown): string => {
    if (file && typeof file === 'object' && 'path' in (file as Record<string, unknown>)) {
      const p = (file as Record<string, unknown>).path
      if (typeof p === 'string' && p) return p
    }
    // 降级：返回标准属性 file.name（供日志/展示），调用方不应据此访问文件系统
    if (file && typeof file === 'object' && 'name' in (file as Record<string, unknown>)) {
      const n = (file as Record<string, unknown>).name
      if (typeof n === 'string') return n
    }
    return ''
  },
}

/** 单例：生成的 web-preload 从这里 import ipcRenderer */
export const ipcRenderer = new WSBridge(resolveWsUrl())

// 页面卸载时主动断开，避免僵尸连接占住单活跃名额
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeunload', () => {
    try {
      ipcRenderer.dispose()
    } catch {
      /* ignore */
    }
  })
}

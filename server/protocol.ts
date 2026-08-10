/**
 * protocol.ts — Proma Web IPC 桥协议定义（阶段 2）
 *
 * 两类通道：
 *  - request 通道：客户端 invoke → 服务端 handler → result（异步，带 id 关联）
 *  - event 通道：main 进程主动推送（Agent 流式 / 权限请求 / 通知），客户端按 channel 订阅
 *
 * 帧类型（JSON 文本帧）：
 *  客户端 → 服务端: invoke | ping | pong
 *  服务端 → 客户端: ready | result | event | error | ping | pong | bye
 *
 * 错误通道约定（#13 协议一致性）：
 *  - error 帧：仅用于「无法关联到具体 invoke」的协议级错误
 *    （消息过大 / 非法 JSON / 非法帧 / 未知帧类型），不带 id。
 *  - result 帧（ok:false）：所有 invoke 级错误（未知通道 / handler 异常 / 限流 /
 *    超时 / 重复 id / args 超深 / result 过大 / 连接关闭），带 id 供客户端 settle。
 */

export const PROTOCOL_VERSION = 1
export const PROTOCOL_NAME = 'proma-web-ipc'

// ===================== 客户端 → 服务端 =====================

/** request 通道：调用某个已注册的 IPC handler */
export interface InvokeFrame {
  type: 'invoke'
  /** 客户端自增 id，用于关联 result */
  id: number | string
  /** handler 通道名，如 'runtime:get-status' */
  channel: string
  /** 透传给 handler 的参数列表 */
  args?: unknown[]
}

/** 应用层心跳（客户端保活探测；服务端会回 pong） */
export interface PingFrame {
  type: 'ping'
  /** 客户端时间戳（可选），原样回显便于 RTT 测量 */
  t?: number
}

/** 客户端回应服务端心跳；服务端也会用 pong 回应客户端 ping（双向） */
export interface PongFrame {
  type: 'pong'
  t?: number
}

export type ClientFrame = InvokeFrame | PingFrame | PongFrame

// ===================== 服务端 → 客户端 =====================

/** 连接握手：认证通过后第一条帧 */
export interface ReadyFrame {
  type: 'ready'
  protocol: number
  /** 服务端单条 WS 消息大小上限（字节）；可选字段，旧服务端不发送时客户端用默认 4MB */
  maxMsgBytes?: number
  /** 当前可 invoke 的全部 handler 通道 */
  channels: string[]
  server: {
    name: string
    version: string
    pid: number
    uptime: number
  }
}

/** request 通道响应 */
export interface ResultFrame {
  type: 'result'
  id: number | string
  ok: boolean
  result?: unknown
  /** ok=false 时的错误消息（已脱敏，不含堆栈） */
  error?: string
}

/** event 通道：main → 客户端推送（payload 即 handler 中 event.sender.send 的参数） */
export interface EventFrame {
  type: 'event'
  channel: string
  payload: unknown[]
}

/** 协议级错误（非 invoke 结果）：消息过大 / 限流 / 超时 / 无效帧 */
export interface ErrorFrame {
  type: 'error'
  code: string
  message: string
}

/** 服务端主动断开前告知原因（如单活跃连接互斥被新连接顶替） */
export interface ByeFrame {
  type: 'bye'
  reason: string
}

/** 服务端心跳探测（客户端应回 pong） */
export interface ServerPingFrame {
  type: 'ping'
  t?: number
}

export type ServerFrame =
  | ReadyFrame
  | ResultFrame
  | EventFrame
  | ErrorFrame
  | ByeFrame
  | ServerPingFrame
  | PongFrame

// ===================== 协议级错误码 =====================
// 仅用于 error 帧（无法关联 invoke 的协议级错误）。
// invoke 级错误一律走 result 帧 ok:false（见文件头「错误通道约定」）。

export const ERR = {
  BAD_JSON: 'bad_json',
  MSG_TOO_LARGE: 'message_too_large',
  INVALID_FRAME: 'invalid_frame',
  UNKNOWN_FRAME: 'unknown_frame',
} as const

// ===================== 心跳参数 =====================

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 90_000

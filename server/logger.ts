/**
 * logger.ts — 结构化 JSON 日志（单行，便于日志系统收集）
 *
 * 级别：debug < info < warn < error（PROMA_WEB_LOG_LEVEL 控制，默认 info）
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const configured = (process.env.PROMA_WEB_LOG_LEVEL || 'info').toLowerCase() as LogLevel
const threshold = LEVEL_ORDER[configured] ?? LEVEL_ORDER.info

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) entry[k] = v
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}

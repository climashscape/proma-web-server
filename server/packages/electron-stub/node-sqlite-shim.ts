/**
 * node-sqlite-shim.ts — node:sqlite → bun:sqlite 适配（阶段 3）
 *
 * 背景：Bun 1.3.14 无 node:sqlite 兼容层，planning 模块（planning-manager.ts）只读 handler
 *       （planning:list-todos 等）全部报 "No such built-in module: node:sqlite"。
 *       本 shim 提供 node:sqlite DatabaseSync 的子集（exec / prepare().get|all|run），
 *       底层用 Bun 内置 bun:sqlite。
 *
 * 关键差异处理：
 *  - 命名参数前缀：node:sqlite 用 `:name`，bun:sqlite 绑定对象键需带 `$`（`{$name: v}`）。
 *    → prepare() 时把 SQL 的 `:name` 转为 `$name`；get/all/run 时把绑定对象键补 `$` 前缀。
 *  - node:sqlite 的 `?` 位置参数与 bun:sqlite 兼容（planning 未使用，不特殊处理）。
 *
 * 接入：patch-proma.sh 把 planning-manager.ts 的 `require('node:sqlite')`
 *       替换为 `require('@proma/electron-stub/node-sqlite-shim')`。
 */

import { Database } from 'bun:sqlite'

/** node:sqlite `:name` → bun:sqlite `$name`（JS replace 中 $$ 表示字面 $） */
function convertSql(sql: string): string {
  return sql.replace(/:([a-zA-Z0-9_]+)/g, '$$$1')
}

/** 绑定对象键补 $ 前缀（bun:sqlite 要求键带前缀） */
function convertParams(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    out[k.startsWith('$') || k.startsWith(':') || k.startsWith('@') ? k : `$${k}`] = v
  }
  return out
}

/** node:sqlite DatabaseSync 的兼容子集 */
export class DatabaseSync {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): {
    get: (params?: unknown) => unknown
    all: (params?: unknown) => unknown[]
    run: (params?: unknown) => { changes: number; lastInsertRowid: number }
  } {
    const stmt = this.db.prepare(convertSql(sql))
    return {
      get: (params?: unknown) => stmt.get(convertParams(params)) as unknown,
      all: (params?: unknown) => stmt.all(convertParams(params)) as unknown[],
      run: (params?: unknown) =>
        stmt.run(convertParams(params)) as { changes: number; lastInsertRowid: number },
    }
  }

  close(): void {
    this.db.close()
  }
}

export default { DatabaseSync }

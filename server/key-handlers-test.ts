/**
 * key-handlers-test.ts — 关键 handler 冒烟测试（M4）
 *
 * 覆盖 320 个 handler 中的核心业务路径（全部为只读/查询型，不触发写操作）：
 *  - agent 会话/工作区/能力/技能
 *  - chat 对话列表
 *  - automation 定时任务列表
 *  - planning 待办/分组
 *  - 其他基础（runtime/settings/channel 已在 client-test 覆盖）
 *
 * 用法: PROMA_WEB_TOKEN=xxx bun run key-handlers-test.ts
 */

const WS_URL = process.env.PROMA_WEB_WS || 'ws://127.0.0.1:6810/ws'
const WS_TOKEN = process.env.PROMA_WEB_TOKEN || ''
if (!WS_TOKEN) {
  console.error('[key-test] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

const TARGETS: Array<{ channel: string; args?: unknown[]; expectOk?: boolean; note?: string; skipIfNoWorkspace?: boolean }> = [
  { channel: 'agent:list-sessions', args: [] },
  { channel: 'agent:list-workspaces', args: [] },
  { channel: 'agent:get-capabilities', args: ['default'], note: 'workspaceSlug=动态', skipIfNoWorkspace: true },
  { channel: 'agent:get-skills', args: ['default'], note: 'workspaceSlug=动态', skipIfNoWorkspace: true },
  { channel: 'chat:list-conversations', args: [] },
  { channel: 'automation:list', args: [] },
  { channel: 'planning:list-todos', args: [], note: 'bun:sqlite shim（node-sqlite-shim）' },
  { channel: 'planning:list-groups', args: ['todo'], note: 'bun:sqlite shim' },
]

const url = WS_URL + (WS_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(WS_TOKEN)

async function main(): Promise<void> {
  const ws = new WebSocket(url)
  const pending = new Map<number | string, (r: { ok: boolean; result?: unknown; error?: string }) => void>()
  let nextId = 1

  const invoke = (channel: string, args: unknown[] = []): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const id = nextId++
    return new Promise((resolvePromise) => {
      pending.set(id, resolvePromise)
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    })
  }

  const ready = new Promise<void>((resolveReady) => {
    const timer = setTimeout(() => {
      console.error('[key-test] 连接超时')
      process.exit(1)
    }, 10_000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.type === 'ready') {
        clearTimeout(timer)
        resolveReady()
      } else if (msg.type === 'result') {
        const r = pending.get(msg.id)
        if (r) {
          pending.delete(msg.id)
          r({ ok: msg.ok, result: msg.result, error: msg.error })
        }
      }
    }
    ws.onerror = () => {
      console.error('[key-test] WS 错误')
      process.exit(1)
    }
  })

  await ready
  console.log('[key-test] 已连接，开始关键 handler 冒烟\n')

  // M10 修复：动态获取 workspace slug（agent:get-capabilities/get-skills 需要）
  const wsRes = await invoke('agent:list-workspaces', [])
  let workspaceSlug = ''
  if (wsRes.ok && Array.isArray(wsRes.result) && (wsRes.result as Array<{ slug?: string }>).length > 0) {
    workspaceSlug = (wsRes.result as Array<{ slug?: string }>)[0]?.slug ?? ''
  }
  if (workspaceSlug) {
    for (const t of TARGETS) {
      if (t.skipIfNoWorkspace && t.args) t.args = [workspaceSlug]
    }
  }

  let failures = 0
  let skipped = 0
  for (const t of TARGETS) {
    if (t.skipIfNoWorkspace && !workspaceSlug) {
      console.log(`⏭️  ${t.channel} [无 workspace，跳过]`)
      skipped++
      continue
    }
    const r = await invoke(t.channel, t.args ?? [])
    const expectOk = t.expectOk ?? true
    const ok = r.ok === expectOk
    const tag = r.ok ? '✅' : t.expectOk === false ? '⚠️' : '❌'
    const summary = r.ok ? JSON.stringify(r.result).slice(0, 100) : r.error
    console.log(`${tag} ${t.channel}${t.note ? ` [${t.note}]` : ''}${summary ? ` — ${summary}` : ''}`)
    if (!ok) failures++
  }

  ws.close()
  console.log(`\n===== 结论 =====`)
  console.log(failures === 0 ? `✅ 关键 handler ${TARGETS.length - skipped} 项通过（跳过 ${skipped}）` : `❌ ${failures} 项失败（跳过 ${skipped}）`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[key-test] 异常:', err)
  process.exit(1)
})

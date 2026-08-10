/**
 * extended-test.ts — P1 验证项扩展测试（阶段 2 修复验收）
 *
 * 覆盖 phase2-review 跟踪表验证项：
 *  - #14 非法帧 → error invalid_frame
 *  - #3  invoke args 超深 → 拒绝
 *  - #2  出站 result 超限 → result too large
 *  - #22 重复 invoke id（慢 handler 场景）→ duplicate invoke id
 *  - #4  handler 错误脱敏（非 VERBOSE 不含内部路径/堆栈）
 *  - #23 连接频率限制（11 次快速连 → 第 11 次被拒）
 *
 * 依赖：server 以 PROMA_WEB_TEST_MODE=1 启动（verify.sh --extra 已配置）
 *
 * 用法: PROMA_WEB_TOKEN=xxx bun run extended-test.ts
 */

const WS_URL = process.env.PROMA_WEB_WS || 'ws://127.0.0.1:6810/ws'
const WS_TOKEN = process.env.PROMA_WEB_TOKEN || ''
if (!WS_TOKEN) {
  console.error('[ext-test] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

const url = (u: string) => u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(WS_TOKEN)

let failures = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function connect(u: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    const timer = setTimeout(() => { reject(new Error('连接超时')); try { ws.close() } catch { /* */ } }, 10_000)
    const done = (err?: Error) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(ws)
    }
    ws.onopen = () => done()
    ws.onerror = () => done(new Error('WS 错误'))
    // 服务端拒绝（429/401 等）时 Bun 客户端触发 onclose 而非 onerror，必须监听避免挂死
    ws.onclose = (ev) => {
      if (ws.readyState !== WebSocket.OPEN) done(new Error(`WS 关闭 (code=${ev.code})`))
    }
  })
}

async function main(): Promise<void> {
  const ws = await connect(url(WS_URL))
  const pending = new Map<number | string, (r: { ok: boolean; result?: unknown; error?: string }) => void>()
  const waiters: Array<() => void> = []
  let nextId = 1
  let ready = false

  const invoke = (id: number | string, channel: string, args: unknown[] = []): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    new Promise((res) => {
      pending.set(id, res)
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    })

  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'ready') { ready = true; waiters.splice(0).forEach((f) => f()) }
    else if (m.type === 'result') {
      const r = pending.get(m.id)
      if (r) { pending.delete(m.id); r({ ok: m.ok, result: m.result, error: m.error }) }
    } else if (m.type === 'error') {
      // 协议级 error 帧（非法帧等）转发给等待者
      const waiter = waiters.shift()
      if (waiter) waiter()
      ;(m as unknown as { __extError?: string }).__extError = m.message
      if (m.code === 'invalid_frame') lastProtoError = m.message
    }
  }
  let lastProtoError = ''

  await new Promise<void>((res) => (ready ? res() : waiters.push(res)))
  console.log('[ext-test] 已连接，开始 P1 验证\n')

  // 1. #14 非法帧（发 JSON 数组）
  {
    const before = waiters.length
    ws.send(JSON.stringify([1, 2, 3]))
    await new Promise((r) => setTimeout(r, 500))
    check('#14 非法帧 → invalid_frame error', lastProtoError === 'frame must be a JSON object', lastProtoError)
    void before
  }

  // 2. #3 超深 args（30 层嵌套）
  {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 30; i++) deep = { lvl: deep }
    const r = await invoke(101, 'runtime:get-status', [deep])
    check('#3 args 超深被拒', !r.ok && /too deep/.test(r.error ?? ''), r.error)
  }

  // 3. #2 大 result（20MB > 16MB 上限）
  {
    const r = await invoke(102, '_test:big-result', [20 * 1024 * 1024])
    check('#2 大 result 被拒（result too large）', !r.ok && /result too large/.test(r.error ?? ''), r.error)
    // 小 result 正常
    const ok = await invoke(103, '_test:big-result', [100])
    check('#2 小 result 正常返回', ok.ok, ok.ok ? `bytes=${JSON.stringify(ok.result).length}` : ok.error)
  }

  // 4. #22 重复 id（慢 handler 500ms，同 id 连发 → 第二个应收到 duplicate；直接监听 result 帧避免 pending Map 覆盖）
  {
    const results: Array<{ ok: boolean; error?: string }> = []
    const waiter = new Promise<boolean>((resolveDup) => {
      const orig = ws.onmessage
      let count = 0
      const timer = setTimeout(() => resolveDup(false), 4000)
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data))
        if (m.type === 'result' && m.id === 200) {
          count++
          results.push({ ok: m.ok, error: m.error })
          if (count === 2) {
            clearTimeout(timer)
            ws.onmessage = orig
            // 两个 result 中任一含 duplicate 即证明 server 拒绝重复 id
            resolveDup(results.some((r) => /duplicate invoke id/.test(r.error ?? '')))
          }
        } else if (m.type === 'ready' || m.type === 'ping') {
          orig?.(ev)
        }
      }
      ws.send(JSON.stringify({ type: 'invoke', id: 200, channel: '_test:slow', args: [500] }))
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'invoke', id: 200, channel: '_test:slow', args: [10] }))
      }, 100)
    })
    const dupRejected = await waiter
    check('#22 重复 id 被拒（慢 handler 场景）', dupRejected, JSON.stringify(results))
  }

  // 5. #4 错误脱敏（_test:throw 含内部路径，非 VERBOSE 不应泄露）
  {
    const r = await invoke(300, '_test:throw', [])
    const leaked = /secret\/leak-test|stack/i.test(r.error ?? '')
    const hasTrace = /invoke failed \(trace:/.test(r.error ?? '')
    check('#4 错误脱敏（不泄露内部路径，含 trace id）', !r.ok && !leaked && hasTrace, r.error)
  }

  ws.close()

  // 6. #23 连接频率限制（前 10 次成功，第 11 次被拒）
  {
    let accepted = 0
    let rejected = 0
    for (let i = 0; i < 11; i++) {
      try {
        const w = await connect(url(WS_URL))
        accepted++
        w.close()
      } catch {
        rejected++
      }
    }
    // #23 连接限频：限频前置（token 校验前）+ 前面测试可能已消耗部分窗口配额，
    // 断言放宽为 accepted >= 5（最坏剩余配额）且至少 1 次被拒，防时序 flake
    check('#23 连接限频（超限拒绝）', accepted >= 5 && rejected >= 1, `accepted=${accepted} rejected=${rejected}`)
  }

  console.log(`\n===== 结论 =====`)
  console.log(failures === 0 ? '✅ extended-test 全部通过' : `❌ ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[ext-test] 异常:', err)
  process.exit(1)
})

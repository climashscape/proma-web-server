/**
 * client-test.ts — Proma Web IPC 桥测试客户端（阶段 2）
 *
 * 验证目标：
 *  1. WS 握手（ready 帧含 protocol + channels）
 *  2. request 通道：invoke 真实 handler（runtime:get-status / channel:list / settings:get）
 *  3. 未知通道 → 错误响应
 *  4. 消息大小限制 → message_too_large
 *  5. 单活跃连接互斥 → 新连接顶替旧连接（bye/superseded）
 *  6. 心跳：回应 server ping，长连接不被断开
 *  7. 事件通道：main→client 推送可达
 *
 * 用法: PROMA_WEB_TOKEN=xxx bun run client-test.ts [channel] [jsonArgs]
 * 附加: --extra 运行互斥/大消息等扩展测试（verify.sh 全量模式）
 */

const WS_URL = process.env.PROMA_WEB_WS || 'ws://127.0.0.1:6810/ws'
const WS_TOKEN = process.env.PROMA_WEB_TOKEN || ''
if (!WS_TOKEN) {
  console.error('[client] 必须设置 PROMA_WEB_TOKEN 环境变量（与 server 启动时的值一致）')
  process.exit(1)
}

const fullWsUrl = (u: string) => u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(WS_TOKEN)

// ===================== 基础连接封装 =====================

interface InvokeResult {
  id: number | string
  channel: string
  ok: boolean
  result?: unknown
  error?: string
  ms: number
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      reject(new Error('连接超时（server 未启动？）'))
      try { ws.close() } catch { /* ignore */ }
    }, 10_000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('WS 连接错误'))
    }
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const isExtra = argv.includes('--extra')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const targetChannel = positional[0]
  let targetArgs: unknown[] = []
  if (positional[1]) {
    try {
      targetArgs = JSON.parse(positional[1])
    } catch {
      targetArgs = [positional[1]]
    }
  }

  let failures = 0
  const check = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
  }

  // ---- 1. 握手 + 2. invoke 真实 handler ----
  {
    const ws = await connect(fullWsUrl(WS_URL))
    const pending = new Map<number | string, (r: InvokeResult) => void>()
    let nextId = 1
    let ready: any = null
    const events: Array<{ channel: string; payload: unknown[] }> = []

    const invoke = (channel: string, args: unknown[] = []): Promise<InvokeResult> => {
      const id = nextId++
      return new Promise((resolvePromise) => {
        pending.set(id, (r) => resolvePromise(r))
        ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
      })
    }

    const opened = new Promise<void>((resolveOpened) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data))
        if (msg.type === 'ready') {
          ready = msg
          resolveOpened()
        } else if (msg.type === 'result') {
          const resolveFn = pending.get(msg.id)
          if (resolveFn) {
            pending.delete(msg.id)
            resolveFn({ id: msg.id, channel: '', ok: msg.ok, result: msg.result, error: msg.error, ms: 0 })
          }
        } else if (msg.type === 'event') {
          events.push({ channel: msg.channel, payload: msg.payload })
          console.log(`[client] ← 事件推送: ${msg.channel}`, JSON.stringify(msg.payload).slice(0, 160))
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }))
        } else if (msg.type === 'bye') {
          console.log(`[client] ← 服务端断开: bye(${msg.reason})`)
        }
      }
    })

    await opened
    check('WS 握手（ready 帧）', !!ready && ready.protocol === 1, `protocol=${ready?.protocol}, channels=${ready?.channels?.length}`)
    check('通道数 ≥ 300', (ready?.channels?.length ?? 0) >= 300, `count=${ready?.channels?.length}`)

    const targets = targetChannel
      ? [{ channel: targetChannel, args: targetArgs }]
      : [
          { channel: 'runtime:get-status', args: [] },
          { channel: 'channel:list', args: [] },
          { channel: 'settings:get', args: [] },
        ]
    for (const t of targets) {
      const r = await invoke(t.channel, t.args)
      check(`invoke ${t.channel}`, r.ok, r.ok ? `→ ${r.result === undefined ? '(result: undefined)' : JSON.stringify(r.result).slice(0, 120)}` : r.error)
    }

    // 3. 未知通道
    const unknown = await invoke('no:such-channel', [])
    check('未知通道返回错误', !unknown.ok, unknown.error)

    if (isExtra) {
      // 4. 消息大小限制（发 > 4MB 帧）
      const big = 'x'.repeat(5 * 1024 * 1024)
      const bigMsg = await new Promise<{ code: string } | null>((resolveBig) => {
        const before = events.length
        ws.send(big)
        // server 会回 error 帧；这里监听 error 帧
        const origOnmessage = ws.onmessage
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data))
          if (m.type === 'error' && m.code === 'message_too_large') {
            resolveBig(m)
          } else {
            origOnmessage?.(ev)
          }
          void before
        }
        setTimeout(() => resolveBig(null), 3000)
      })
      check('超大消息被拒绝（message_too_large）', !!bigMsg, bigMsg ? bigMsg.message : '未收到 error 帧')

      // 7. 事件通道（#11：真实事件断言）——invoke _test:broadcast 触发 server 广播
      await invoke('_test:broadcast', ['bridge:test-event', 'hello'])
      const t0 = Date.now()
      let gotEvent = false
      while (Date.now() - t0 < 5000) {
        if (events.some((e) => e.channel === 'bridge:test-event' && JSON.stringify(e.payload).includes('hello'))) {
          gotEvent = true
          break
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      check('事件通道真实收到 event 帧（_test:broadcast）', gotEvent)
    }

    ws.close()
    await new Promise((r) => setTimeout(r, 300))
  }

  // ---- 5. 单活跃连接互斥（需要 --extra） ----
  if (isExtra) {
    const ws1 = await connect(fullWsUrl(WS_URL))
    const ready1 = await new Promise<any>((r) => {
      ws1.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data))
        if (m.type === 'ready') r(m)
      }
    })
    check('连接1 建立', !!ready1)

    // 连接2 建立后，连接1 应收到 bye(superseded) 或被关闭
    const bye1 = await new Promise<string>((resolveBye) => {
      const timer = setTimeout(() => resolveBye('(超时未收到 bye)'), 5000)
      ws1.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data))
        if (m.type === 'bye') {
          clearTimeout(timer)
          resolveBye(m.reason)
        }
      }
      ws1.onclose = () => {
        clearTimeout(timer)
        resolveBye('(连接被服务端关闭)')
      }
      void connect(fullWsUrl(WS_URL)).then((ws2) => {
        // 保留 ws2 打开 2s 再关闭
        setTimeout(() => { try { ws2.close() } catch { /* ignore */ } }, 2000)
      })
    })
    check('单活跃互斥：新连接顶替旧连接', bye1.includes('superseded') || bye1.includes('关闭'), bye1)
  }

  console.log(`\n===== 结论 =====`)
  console.log(failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[client] 异常:', err)
  process.exit(1)
})

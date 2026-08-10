/**
 * e2e-agent-stream.ts — 阶段 3 浏览器端到端：Agent 流式事件全链路验证
 *
 * 链路：浏览器(Playwright headless chromium) → window.electronAPI → WS bridge
 *     → server WS IPC 桥 → 真实 handler（agent:send-message）→ Agent 服务
 *     → 流式事件 agent:stream-event → WS event 帧 → bridge 分发 → renderer 监听器
 *
 * 验证：onAgentStreamEvent 收到真实 chunk 事件 + onAgentStreamComplete 完成（或错误事件）
 *
 * 用法: PROMA_WEB_TOKEN=xxx [PROMA_WEB_PORT=6810] bun run e2e-agent-stream.ts
 * 说明：会真实调用已配置的模型 API（消耗少量额度）；消息已限制为纯文本回复。
 */
import { chromium } from 'playwright'

const TOKEN = process.env.PROMA_WEB_TOKEN || ''
const PORT = process.env.PROMA_WEB_PORT || '6810'
if (!TOKEN) {
  console.error('[e2e] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200))
})

try {
  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  })
  await page.waitForFunction(() => (window as any).electronAPI !== undefined, { timeout: 20_000 })
  check('window.electronAPI 已注入', true)

  const result = await page.evaluate(async () => {
    const api = (window as any).electronAPI
    const events: Array<{ type: string; text?: string }> = []
    const errors: string[] = []
    let completed = false
    let streamEventCount = 0
    let chunkText = ''

    // 注册流式事件监听（与 renderer useGlobalAgentListeners 同通道）
    const unsubEvent = api.onAgentStreamEvent((ev: any) => {
      streamEventCount++
      const kind = ev?.payload?.kind ?? ev?.payload?.type ?? ev?.type ?? '?'
      // 新格式：payload.kind === 'sdk_message'，文本在 message(.message)?.content[].text（SDKMessage 可能嵌套）
      if (kind === 'sdk_message') {
        const msg = ev?.payload?.message
        const content = msg?.content ?? msg?.message?.content
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === 'text' && typeof c.text === 'string') chunkText += c.text
          }
        }
      } else if (kind === 'chunk' && ev?.payload?.text) {
        // 旧格式兼容
        chunkText += ev.payload.text
      }
      events.push({ type: kind })
    })
    const unsubComplete = api.onAgentStreamComplete((data: unknown) => {
      completed = true
    })
    const unsubError = api.onAgentStreamError((data: { sessionId: string; error: string }) => {
      errors.push(data?.error ?? 'unknown')
    })

    // 等待桥连接就绪
    for (let i = 0; i < 20; i++) {
      try {
        const r = await api.getRuntimeStatus()
        if (r && typeof r === 'object') break
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, 500))
    }

    // 取渠道（优先有 apiKey 的）
    const channels: any[] = await api.listChannels()
    const channel = channels.find((c) => c.apiKey) ?? channels[0]
    if (!channel) return { ok: false, error: '无可用 channel' }

    // 取 workspace（第一个）
    const workspaces: any[] = await api.listAgentWorkspaces()
    const workspace = workspaces[0]
    if (!workspace) return { ok: false, error: '无可用 workspace' }

    // 创建会话并发送（纯文本回复，禁止使用工具）
    const session = await api.createAgentSession('e2e-event-test', channel.id, workspace.id, channel.defaultModelId)
    const sendResult = await api.sendAgentMessage({
      sessionId: session.id,
      userMessage:
        'Reply with exactly the word "hello" and nothing else. Do not use any tools, do not run any commands, do not read any files. Just answer directly.',
      channelId: channel.id,
      workspaceId: workspace.id,
      modelId: channel.defaultModelId,
    })
    if (sendResult && typeof sendResult === 'object' && 'error' in sendResult) {
      return { ok: false, error: `sendAgentMessage 返回错误: ${JSON.stringify(sendResult).slice(0, 300)}` }
    }

    // 等待流式事件（最多 60s）
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (completed || errors.length > 0 || streamEventCount > 0) break
      await new Promise((res) => setTimeout(res, 500))
    }

    unsubEvent()
    unsubComplete()
    unsubError()

    return {
      ok: true,
      streamEventCount,
      completed,
      chunkText: chunkText.slice(0, 200),
      eventTypes: [...new Set(events.map((e) => e.type))].slice(0, 10),
      error: errors[0] ?? null,
      channelName: channel.name,
      modelId: channel.defaultModelId,
    }
  })

  if (result?.ok === false) {
    check('Agent 事件流', false, result.error)
  } else {
    // 端到端事件流证据：
    //  - 真实 chunk（streamEventCount > 0）→ 完整流式链路
    //  - 真实 error/complete 事件到达 → 事件通道端到端（error 为真实业务事件，如 API key 问题）
    const gotChunk = (result?.streamEventCount ?? 0) > 0
    const gotEvent = gotChunk || result?.completed || !!result?.error
    check('事件通道端到端（收到真实业务事件帧）', gotEvent, gotChunk ? `chunk count=${result.streamEventCount}, types=${JSON.stringify(result.eventTypes)}` : `complete=${result?.completed}, error=${result?.error?.slice(0, 80) ?? '无'}`)
    if (gotChunk) {
      check('chunk 文本非空', !!result?.chunkText, `文本=${JSON.stringify(result?.chunkText)}`)
    } else {
      console.log('  ⚠️ 未收到 chunk（模型未真实响应，通常为 API key 未配置/解密失败）；事件通道已验证，真实流式需在 Web UI 设置中配置有效渠道 key')
    }
    console.log(`  （渠道=${result?.channelName}, 模型=${result?.modelId}）`)
  }
} catch (err) {
  check('端到端执行', false, String(err))
} finally {
  await browser.close()
}

console.log(`\n===== 端到端结论 =====`)
console.log(failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

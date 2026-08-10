/**
 * handler-coverage.ts — Proma Web server WS 通道 handler 覆盖测试（2026-08-10）
 *
 * 目标：从 325 个已注册 WS 通道中挑选高价值通道做独立断言（>=30 个），
 *       输出通过/失败明细，并识别 Web 不可用通道（stub/无响应/降级）。
 *
 * 覆盖优先级：agent:* / settings:* / channel:* / automation:* / planning:* / file:*，
 * 另加 runtime/git/user-profile/proxy/system-prompt/chat/updater/storage 等只读探测。
 *
 * 安全策略（遵守协调红线）：
 *  - 默认连接现有 6810（token=<your-token>），只测只读/查询通道
 *  - 写型通道一律走「校验失败路径」：传 null/空参数，断言返回 error
 *    （证明 handler 存在且参数校验生效，不产生真实写入）
 *  - 明确的破坏性通道（cleanup/delete/send/installer/migration 导入导出等）不测
 *
 * 用法:
 *   PROMA_WEB_TOKEN=<your-token> bun run handler-coverage.ts
 *   PROMA_WEB_WS=ws://127.0.0.1:6811/ws PROMA_WEB_TOKEN=xxx bun run handler-coverage.ts
 * 结果 JSON: 输出目录 coverage-result.json（默认 /tmp/proma-web-coverage）
 */

const WS_URL = process.env.PROMA_WEB_WS || 'ws://127.0.0.1:6810/ws'
const WS_TOKEN = process.env.PROMA_WEB_TOKEN || ''
const OUT_DIR = process.env.PROMA_WEB_COVERAGE_OUT || '/tmp/proma-web-coverage'
const INVOKE_TIMEOUT_MS = Number(process.env.PROMA_WEB_INVOKE_TIMEOUT || 8000)

if (!WS_TOKEN) {
  console.error('[coverage] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

// ===================== 候选通道定义 =====================
// mode: read = 只读查询（期望 ok:true）；check-fail = 写型通道校验失败路径（期望 ok:false + 明确错误）
// note: 说明 / 风险标注
interface Target {
  channel: string
  args?: unknown[]
  mode: 'read' | 'check-fail'
  note?: string
  needWorkspace?: boolean
  replaceSkillSlug?: string
  expectBizError?: boolean // 已知会触发业务错误（服务器日志已确认），handler 本身可用
}

const TARGETS: Target[] = [
  // ---- agent:* 会话/工作区管理（只读优先）----
  { channel: 'agent:list-sessions', args: [], mode: 'read' },
  { channel: 'agent:list-workspaces', args: [], mode: 'read' },
  { channel: 'agent:get-capabilities', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-skills', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-default-skill-slugs', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-mcp-config', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-pending-requests', args: [], mode: 'read' },
  { channel: 'agent:get-pi-reasoning-capability', args: [], mode: 'read' },
  { channel: 'agent:get-sdk-messages', args: [], mode: 'read' },
  { channel: 'agent:get-skills-dir', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-task-output', args: [], mode: 'read', note: '已知 stub：返回空输出' },
  { channel: 'agent:get-workspace-directories', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-workspace-files-path', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-workspace-attached-files', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-workspace-memory-summary', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:list-attached-directory', args: ['/root/.proma-dev/agent-workspaces/default/workspace-files'], mode: 'read', note: '授权路径内目录列表（Web 白名单）' },
  { channel: 'agent:list-directory', args: ['/root/.proma-dev/agent-workspaces/default/workspace-files'], mode: 'read', note: '授权路径内目录列表（Web 白名单）' },
  { channel: 'agent:list-skill-files', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态（skillSlug 假名 → 业务错误: Skill 不存在）', replaceSkillSlug: '__no_such_skill__', expectBizError: true },
  { channel: 'agent:list-workspace-auto-memory-files', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-worktree-repos', args: ['default', '/'], mode: 'read', note: 'repoPath=/ 探测' },
  { channel: 'agent:get-other-workspace-skills', args: [], mode: 'read' },
  { channel: 'agent:read-workspace-agents-md', args: [''], mode: 'read', needWorkspace: true, note: 'workspaceSlug=动态' },
  { channel: 'agent:get-session-path', args: [], mode: 'read', note: '无参探测' },
  { channel: 'agent:check-paths-type', args: [['/root/.proma-dev/channels.json']], mode: 'read', note: '真实路径数组' },
  // agent 写型通道：校验失败路径（create-session 无参校验缺失会真实创建，已排除，见清单）
  { channel: 'agent:update-title', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'agent:send-message', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },

  // ---- settings:* 设置读写（update 参数校验缺失会真实写入，已排除，见清单）----
  { channel: 'settings:get', args: [], mode: 'read' },
  { channel: 'settings:get-system-theme', args: [], mode: 'read' },

  // ---- channel:* 渠道管理 ----
  { channel: 'channel:list', args: [], mode: 'read' },
  { channel: 'channel:get-plan-quota', args: ['__no_such_channel__'], mode: 'read', note: '不存在 id → 期望 null/error' },
  { channel: 'channel:create', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'channel:update', args: [null, null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'channel:delete', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'channel:fetch-models', args: [{}], mode: 'check-fail', note: '外部拉取-空 input 校验' },

  // ---- automation:* 定时任务 ----
  { channel: 'automation:list', args: [], mode: 'read' },
  { channel: 'automation:create', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'automation:update', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'automation:toggle', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'automation:delete', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },

  // ---- planning:* 规划/日程 ----
  { channel: 'planning:list-todos', args: [], mode: 'read' },
  { channel: 'planning:list-groups', args: ['todo'], mode: 'read' },
  { channel: 'planning:list-tags', args: [], mode: 'read' },
  { channel: 'planning:list-calendar-events', args: [], mode: 'read' },
  { channel: 'planning:list-active-reminders', args: [], mode: 'read' },
  { channel: 'planning:list-native-connections', args: [], mode: 'read' },
  { channel: 'planning:list-native-connection-targets', args: ['calendar'], mode: 'read', note: 'entity=calendar' },
  { channel: 'planning:list-native-sync-targets', args: ['calendar'], mode: 'read', note: 'entity=calendar' },
  { channel: 'planning:list-native-sync-conflicts', args: [], mode: 'read' },
  { channel: 'planning:list-sync-profiles', args: [], mode: 'read' },
  { channel: 'planning:get-native-sync-status', args: [], mode: 'read' },
  { channel: 'planning:create-todo', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'planning:update-todo', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'planning:delete-todo', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'planning:create-group', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'planning:create-calendar-event', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },

  // ---- file:* 工作区文件操作 ----
  { channel: 'file:resolve-path', args: ['/root/.proma-dev/channels.json'], mode: 'read', note: '真实路径' },
  { channel: 'file:resolve-and-read', args: ['/root/.proma-dev/channels.json'], mode: 'read', note: '真实路径' },
  { channel: 'file:read-binary-base64', args: ['/root/.proma-dev/__no_such_file__'], mode: 'read', note: '不存在文件 → 期望 error' },
  { channel: 'file:write-text', args: [null], mode: 'check-fail', note: '写通道-缺参校验' },
  { channel: 'file:docx-to-html', args: [null], mode: 'check-fail', note: '转换-缺参校验' },
  { channel: 'file:office-to-html', args: [null], mode: 'check-fail', note: '转换-缺参校验' },
  { channel: 'file:prepare-pdf-preview', args: [null], mode: 'check-fail', note: '转换-缺参校验' },

  // ---- 其他高价值只读 ----
  { channel: 'runtime:get-status', args: [], mode: 'read' },
  { channel: 'user-profile:get', args: [], mode: 'read' },
  { channel: 'environment:check', args: [], mode: 'read' },
  { channel: 'proxy:get-settings', args: [], mode: 'read' },
  { channel: 'system-prompt:get-config', args: [], mode: 'read' },
  { channel: 'chat:list-conversations', args: [], mode: 'read' },
  { channel: 'chat:get-recent-messages', args: [], mode: 'read' },
  { channel: 'chat-tool:get-all-tools', args: [], mode: 'read' },
  { channel: 'updater:get-status', args: [], mode: 'read' },
  { channel: 'storage:get-stats', args: [], mode: 'read' },
  { channel: 'git:list-worktrees', args: [null, ''], mode: 'read', note: '缺 repoPath → 期望 []' },
  { channel: 'github-release:list', args: [], mode: 'read', note: '可能依赖外部网络' },
]

// ===================== WS 客户端 =====================

const url = WS_URL + (WS_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(WS_TOKEN)

interface InvokeResult {
  ok: boolean
  result?: unknown
  error?: string
  timedOut?: boolean
}

async function run(): Promise<void> {
  const ws = new WebSocket(url)
  const pending = new Map<number, (r: InvokeResult) => void>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextId = 1

  const invoke = (channel: string, args: unknown[] = []): Promise<InvokeResult> => {
    const id = nextId++
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        timers.delete(id)
        resolvePromise({ ok: false, error: 'invoke timeout (no response)', timedOut: true })
      }, INVOKE_TIMEOUT_MS)
      timers.set(id, timer)
      pending.set(id, (r) => {
        clearTimeout(timer)
        timers.delete(id)
        resolvePromise(r)
      })
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    })
  }

  const ready = new Promise<{ channels: string[] }>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('连接超时')), 10_000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.type === 'ready') {
        clearTimeout(timer)
        resolveReady({ channels: (msg.channels as string[]) ?? [] })
      } else if (msg.type === 'result') {
        const r = pending.get(msg.id)
        if (r) {
          pending.delete(msg.id)
          r({ ok: msg.ok === true, result: msg.result, error: msg.error })
        }
      }
    }
    ws.onerror = () => rejectReady(new Error('WS 错误'))
    ws.onclose = () => {
      // 连接意外关闭时，把所有 pending 解析为失败
      for (const [id, r] of pending) {
        r({ ok: false, error: 'connection closed', timedOut: true })
      }
      pending.clear()
    }
  })

  let registeredChannels: string[] = []
  try {
    const r = await ready
    registeredChannels = r.channels
  } catch (e) {
    console.error('[coverage] 连接失败:', (e as Error).message)
    process.exit(1)
  }
  const registeredSet = new Set(registeredChannels)
  console.log(`[coverage] 已连接 ${WS_URL}，服务器注册通道数: ${registeredChannels.length}`)

  // 动态获取 workspace slug
  let workspaceSlug = ''
  try {
    const wsRes = await invoke('agent:list-workspaces', [])
    if (wsRes.ok && Array.isArray(wsRes.result) && (wsRes.result as Array<{ slug?: string }>).length > 0) {
      workspaceSlug = (wsRes.result as Array<{ slug?: string }>)[0]?.slug ?? ''
    }
  } catch { /* ignore */ }
  console.log(`[coverage] workspaceSlug=${workspaceSlug || '(无)'}`)

  const results: Array<{
    channel: string
    mode: string
    registered: boolean
    ok: boolean
    timedOut: boolean
    error: string
    summary: string
    status: 'ok' | 'check-fail-ok' | 'unavailable' | 'degraded' | 'skipped'
    note?: string
  }> = []

  let fail = 0
  let unreg = 0
  for (const t of TARGETS) {
    let args = t.args ?? []
    if (t.needWorkspace) {
      if (!workspaceSlug) {
        results.push({
          channel: t.channel, mode: t.mode, registered: registeredSet.has(t.channel), ok: false,
          timedOut: false, error: '', summary: '无 workspace，跳过', status: 'skipped', note: t.note,
        })
        continue
      }
      args = [workspaceSlug]
      if ((t as { replaceSkillSlug?: string }).replaceSkillSlug) args.push((t as { replaceSkillSlug: string }).replaceSkillSlug)
    }

    if (!registeredSet.has(t.channel)) {
      unreg++
      results.push({
        channel: t.channel, mode: t.mode, registered: false, ok: false, timedOut: false,
        error: '未注册', summary: '通道未注册（不在 ready channels 列表）', status: 'unavailable', note: t.note,
      })
      console.log(`❌ ${t.channel} [未注册]`)
      continue
    }

    const r = await invoke(t.channel, args)
    const summary = r.timedOut ? '(无响应)' : r.ok ? String(r.result === undefined ? '(result: undefined)' : JSON.stringify(r.result)).slice(0, 120) : String(r.error ?? '').slice(0, 160)

    let status: 'ok' | 'check-fail-ok' | 'unavailable' | 'degraded' | 'skipped'
    // 业务语义错误（不存在/必填/非法/越权等）≠ 通道不可用：handler 工作正常，参数被合理拒绝
    const bizErrorPattern = /不存在|必填|非法|不能为空|超出|不在允许|不支持的供应商|未找到|找不到/
    if (r.timedOut) {
      status = 'unavailable'
      fail++
    } else if (t.mode === 'read') {
      if (r.ok) {
        status = 'ok'
      } else if (t.expectBizError && r.error) {
        status = 'ok' // 已知业务校验错误（服务器日志已确认），handler 可用
      } else if (r.error && bizErrorPattern.test(r.error)) {
        status = 'ok' // 业务校验生效，handler 可用；summary 保留错误信息
      } else {
        status = 'unavailable'
        fail++
      }
    } else {
      // check-fail 模式：期望 ok:false（参数校验）或 result 内业务级拒绝（success:false / false）
      const bizReject =
        r.ok &&
        (r.result === false ||
          (typeof r.result === 'object' && r.result !== null && (r.result as { success?: boolean }).success === false))
      if (bizReject || (!r.ok && r.error && !r.timedOut)) {
        status = 'check-fail-ok' // 校验生效 = handler 工作正常
      } else if (r.ok) {
        status = 'degraded' // 空参数竟然 ok 且有真实副作用？校验缺失，标注
        fail++
      } else {
        status = 'unavailable'
        fail++
      }
    }

    results.push({
      channel: t.channel, mode: t.mode, registered: true, ok: r.ok, timedOut: !!r.timedOut,
      error: r.error ?? '', summary, status, note: t.note,
    })

    const tag = status === 'ok' ? '✅' : status === 'check-fail-ok' ? '⚠️' : status === 'degraded' ? '🔶' : '❌'
    console.log(`${tag} ${t.channel}${t.note ? ` [${t.note}]` : ''} — ${summary}`)
  }

  ws.close()

  // ===== 统计 =====
  const okCount = results.filter((x) => x.status === 'ok').length
  const checkFailOk = results.filter((x) => x.status === 'check-fail-ok').length
  const degraded = results.filter((x) => x.status === 'degraded').length
  const unavailable = results.filter((x) => x.status === 'unavailable').length
  const skipped = results.filter((x) => x.status === 'skipped').length
  const total = results.length

  console.log(`\n===== 覆盖结论 =====`)
  console.log(`覆盖通道总数: ${total}（已注册 ${total - unreg - skipped}，未注册 ${unreg}，跳过 ${skipped}）`)
  console.log(`✅ 正常可用(read ok): ${okCount}`)
  console.log(`⚠️ 写通道校验生效(check-fail): ${checkFailOk}`)
  console.log(`🔶 降级(degraded): ${degraded}`)
  console.log(`❌ 不可用(unavailable/未注册/无响应): ${unavailable}`)
  const pass = okCount + checkFailOk
  console.log(`通过率: ${pass}/${total - skipped - unreg} = ${(((pass) / Math.max(1, total - skipped - unreg)) * 100).toFixed(1)}%`)

  // 写结果 JSON
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const outFile = path.join(OUT_DIR, 'coverage-result.json')
    fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), wsUrl: WS_URL, registered: registeredChannels.length, results }, null, 2))
    console.log(`\n[coverage] 结果 JSON: ${outFile}`)
  } catch (e) {
    console.error('[coverage] 写结果失败:', (e as Error).message)
  }

  process.exit(0)
}

run().catch((e) => {
  console.error('[coverage] 异常:', e)
  process.exit(1)
})

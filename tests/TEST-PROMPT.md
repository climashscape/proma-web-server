# Proma Web 全功能测试提示词

> **用法**：在桌面版 Proma 开一个新会话，把下面全部内容粘贴进去并发送。
> 新会话会自动完成 Web 版 Proma 的完整测试并输出报告。
> **不要用 Web 版 Proma 自己测自己**（可能会有连接互斥干扰），用桌面版。
>
> 环境：WSL 已配 bun/node，Proma 源码在 `<proma-src>`，Web 服务代码在 `/opt/proma-web-server/`。

---

请对你自身的宿主——Proma Web 版（http://127.0.0.1:6810）做**全功能自动化测试**。以下步骤必须按顺序执行，每步完成后输出 ✅/❌ 和关键数据。

## 第一步：环境检查

1. 用 bash 执行 `curl -s -m 3 http://127.0.0.1:6810/health`，确认返回 `{"status":"ok",...}`。如果端口无响应，先启动 server：
   ```bash
   cd /opt/proma-web-server
   PROMA_WEB_TOKEN=<your-token> PROMA_WEB_TEST_MODE=1 PROMA_WEB_PORT=6810 nohup bun run server.ts > /tmp/proma-web-srv.log 2>&1 & echo $! > /tmp/proma-web.pid
   sleep 3
   curl -s http://127.0.0.1:6810/health
   ```
2. bash 执行 `pgrep -f 'bun run server.ts'` 确认进程存在，PID 记录。
3. bash 执行 `curl -s http://127.0.0.1:6810/health | grep -o '"channels":[0-9]*'` 确认通道数（应 >=320）。

## 第二步：自动化回归（verify.sh）

4. bash 执行：
   ```bash
   cd /opt/proma-web-server
   bash verify.sh --extra 2>&1 | tail -50
   ```
   确认最后一行输出 `===== 汇总: ... 通过 / 0 失败 =====`。如果失败，复制失败的检查项。

## 第三步：浏览器端前端错误检查

5. bash 执行（headless chromium 打开页面，收集 console 错误 12 秒）：
   ```bash
   cd /opt/proma-web-server
   cat > /tmp/console-audit.ts <<'AUDIT'
   import { chromium } from 'playwright'
   const browser = await chromium.launch({ headless: true })
   const page = await browser.newPage()
   const errors: string[] = []
   page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)) })
   page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 250)))
   await page.goto('http://127.0.0.1:6810/?token=<your-token>', { waitUntil: 'domcontentloaded', timeout: 20000 })
   await page.waitForFunction(() => (window as any).electronAPI !== undefined, { timeout: 20000 })
   await new Promise((r) => setTimeout(r, 12000))
   const counts = new Map<string, number>()
   for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1)
   console.log('=== FRONTEND ERRORS ===')
   if (counts.size === 0) console.log('✅ 无错误')
   else for (const [k, v] of counts) console.log(v + 'x', k)
   await browser.close()
   AUDIT
   PROMA_WEB_TOKEN=<your-token> bun run /tmp/console-audit.ts 2>&1 | grep -E '===|✅| x '
   ```
   预期：`✅ 无错误`（或仅 AudioContext warning，非 error）。如果有其他错误，逐条列出。

## 第四步：WS 层核心通道冒烟

6. bash 执行（用裸 WebSocket 测 8 个关键 handler）：
   ```bash
   cd /opt/proma-web-server
   PROMA_WEB_TOKEN=<your-token> PROMA_WEB_WS=ws://127.0.0.1:6810/ws bun run key-handlers-test.ts 2>&1 | tail -12
   ```
   预期：`===== 结论 =====` 行显示全通过。

7. bash 执行（测试被顶替后自动重连）：
   ```bash
   cd /opt/proma-web-server
   cat > /tmp/supersede-check.ts <<'SUP'
   ;(globalThis as any).location = { host: '127.0.0.1:6810', protocol: 'http:', search: '' };
   (globalThis as any).localStorage = { getItem: () => '<your-token>', setItem: () => {}, removeItem: () => {} };
   (globalThis as any).__PROMA_WEB_CONFIG__ = { token: '<your-token>' };
   const { ipcRenderer } = await import('./web/preload-bridge')
   await ipcRenderer.ready
   const ok1 = await ipcRenderer.invoke('runtime:get-status')
   console.log('初始连接 invoke ' + (ok1 ? '✅' : '❌'))
   const ws2 = new WebSocket('ws://127.0.0.1:6810/ws?token=<your-token>')
   await new Promise<void>((r) => { ws2.onopen = () => r() })
   console.log('已用第二连接顶替 bridge，等待自动重连…')
   const deadline = Date.now() + 12000
   let recovered = false
   while (Date.now() < deadline) {
     try { const r = await ipcRenderer.invoke('channel:list'); if (Array.isArray(r)) { recovered = true; break } } catch {}
     await new Promise((r) => setTimeout(r, 500))
   }
   console.log(recovered ? '✅ 被顶替后自动重连恢复' : '❌ 未能恢复')
   ws2.close()
   process.exit(recovered ? 0 : 1)
   SUP
   PROMA_WEB_TOKEN=<your-token> bun run /tmp/supersede-check.ts 2>&1 | tail -4
   ```
   预期：两项都 ✅。

## 第五步：Agent 事件流端到端

8. bash 执行（真实 Agent 对话，触发流式 chunk 事件）：
   ```bash
   cd /opt/proma-web-server
   PROMA_WEB_TOKEN=<your-token> bun run e2e-agent-stream.ts 2>&1 | grep -v 'console.error\|任务/日程\|WSBridge.settle\|ws.onmessage' | tail -8
   ```
   预期输出包含 `✅` 且最终 `✅ 全部通过`。如果 API key 无效，会显示 "事件通道端到端" ✅ 并提示 key 未配置。

## 第六步：server 日志错误扫描

9. bash 执行：
   ```bash
   grep -E '"warn"|"error"|invoke failed' /tmp/proma-web-srv.log | grep -v 'node:sqlite' | grep -v '未注册的 channel: no:such-channel\|未注册的 channel: no:sync:channel' | tail -20
   ```
   预期：**无输出**（或仅 planning 已知的剩余）。如果有关键错误，列出。

## 第七步：汇总

输出最终报告，格式如下：
```
=== Proma Web 全功能测试报告 ===
时间：<timestamp>
Server PID：<pid>
通道数：<count>
verify.sh --extra：通过/失败（X 项失败）
前端 console 错误：无 / N 条（列出）
关键 handler 冒烟：通过/失败
被顶替重连：通过/失败
Agent 事件流 E2E：通过/失败（chunk/error/complete）
日志错误：无 / N 条（列出）
=================================
结论：✅ 全量通过 或 ❌ N 项需关注
```
```

把这整段提示词粘贴到桌面版 Proma 的新会话，即可自动完成 Web 版全功能测试并输出报告。

/**
 * bridge-test.ts — preload-bridge 运行态测试（Bun 环境模拟浏览器）
 *
 * 验证：
 *  1. bridge 连接真实 server + ready
 *  2. invoke 真实 handler 往返
 *  3. sendSync 乐观返回 true（不触发真实写）
 *  4. on/once/removeListener 注册与移除不炸
 *  5. event 帧分发到 listener（通过自定义事件验证——server 无直接广播源，此处验证 listener 注册不炸）
 *  6. 心跳：server ping 到达时 bridge 自动回 pong（等待 32s 观察连接保持）
 *
 * 用法: PROMA_WEB_TOKEN=xxx bun run web/bridge-test.ts
 */

// ---- 浏览器环境 shim（在 import bridge 之前设置）----
;(globalThis as any).location = {
  host: '127.0.0.1:6810',
  protocol: 'http:',
  search: '',
}
const memStore = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
}

const WS_TOKEN = process.env.PROMA_WEB_TOKEN || ''
if (!WS_TOKEN) {
  console.error('[bridge-test] 必须设置 PROMA_WEB_TOKEN')
  process.exit(1)
}

// token 通过 __PROMA_WEB_CONFIG__ 注入（模拟浏览器端配置）
;(globalThis as any).__PROMA_WEB_CONFIG__ = { token: WS_TOKEN }

const { ipcRenderer } = await import('./preload-bridge')

let failures = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// 1. 连接 + ready
try {
  await ipcRenderer.ready
  check('bridge 连接 server + ready', true)
} catch (e) {
  check('bridge 连接 server + ready', false, String(e))
  process.exit(1)
}

// 2. invoke 真实 handler
const status = await ipcRenderer.invoke('runtime:get-status')
check('invoke runtime:get-status', !!status && typeof status === 'object', `keys=${Object.keys(status ?? {}).join(',')}`)

// 3. sendSync 乐观返回 true
const syncVal = ipcRenderer.sendSync('no:sync:channel')
check('sendSync 首次乐观返回 true', syncVal === true, `value=${String(syncVal)}`)

// 4. 事件监听注册/移除
let onFired = 0
const listener = () => { onFired++ }
ipcRenderer.on('test:channel', listener)
ipcRenderer.once('test:channel', () => { onFired++ })
ipcRenderer.removeListener('test:channel', listener)
ipcRenderer.removeAllListeners('test:channel')
check('on/once/removeListener 注册与移除无异常', true)

// 5. 事件分发（#10：真实事件断言——server TEST_MODE 广播通道 _test:broadcast）
// 依赖 server 以 PROMA_WEB_TEST_MODE=1 启动（verify.sh 已设置）
const gotEvent = await new Promise<boolean>((resolveEvent) => {
  const timer = setTimeout(() => resolveEvent(false), 5000)
  const l = (event: any, payload: unknown) => {
    if (event && typeof event === 'object' && 'channel' in event && payload === 'hello') {
      clearTimeout(timer)
      ipcRenderer.removeListener('bridge:test-event', l)
      resolveEvent(true)
    }
  }
  ipcRenderer.on('bridge:test-event', l)
  void ipcRenderer
    .invoke('_test:broadcast', 'bridge:test-event', 'hello')
    .catch(() => resolveEvent(false))
})
check('事件分发：真实 event 帧（_test:broadcast → listener）', gotEvent)

// 6. 心跳保持：等待 32s（server 30s 发一次 ping，bridge 自动回 pong），期间连接应保持
console.log('（等待 32s 验证心跳保活…）')
await new Promise((r) => setTimeout(r, 32_000))
const alive = await ipcRenderer.invoke('channel:list').then(() => true).catch(() => false)
check('心跳保活：32s 后连接仍可用', alive)

console.log(`\n===== 结论 =====`)
console.log(failures === 0 ? '✅ bridge 全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

/**
 * build-preload-bundle.ts — 把 web/preload.ts 打包为浏览器可直接引用的 IIFE bundle（阶段 3）
 *
 * 产物: public/web-preload.js（server.ts 注入 renderer index.html 时引用）
 *
 * 依赖解析（web/preload.ts 是生成产物，import 相对路径基于 Proma 源码布局）：
 *  - '@proma/shared' → PROMA_SRC/packages/shared/src/index.ts（workspace TS 源码，无 node 依赖）
 *  - '../types'      → PROMA_SRC/apps/electron/src/types/index.ts（生成产物相对路径失效，重定向）
 *
 * 用法:
 *   PROMA_SRC=/opt/Proma bun run web/build-preload-bundle.ts
 *
 * 说明：web/preload.ts 末尾调用 contextBridge.exposeInMainWorld('electronAPI', ...)，
 *       bridge 实现为 window.electronAPI 赋值——React 启动前执行本 bundle 即完成注入。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMA_SRC = process.env.PROMA_SRC
if (!PROMA_SRC) {
  console.error('[build] 必须设置 PROMA_SRC 环境变量指向 Proma 源码目录')
  process.exit(1)
}
const ENTRY = join(__dirname, 'preload.ts')
const OUT_DIR = join(__dirname, '..', 'public')

const SHARED_ENTRY = join(PROMA_SRC, 'packages/shared/src/index.ts')
const TYPES_ENTRY = join(PROMA_SRC, 'apps/electron/src/types/index.ts')

// ===== NAS 自更新 UI patch（追加到 bundle 末尾）=====
// 桌面版 UpdateCard 在 available 状态只提供「前往下载」（openExternal GitHub），
// NAS 版没有 GitHub 下载流程，需要把按钮改为「立即更新」直接触发 nas-updater:apply；
// done 状态（映射为 downloaded）把「空闲时更新」改为「更新完成，请重启 Proma」。
// 只注入 Web/NAS 版 bundle，桌面版无此文件，天然隔离。
// 注意：不直接修改 React 管理的按钮 DOM（会导致 React diff 报错），
//       available 状态用 document 捕获阶段拦截点击；done 为终态才允许改按钮。
const NAS_UI_PATCH = `
;(function () {
  // === NAS 自更新 UI patch ===
  if (!window.electronAPI || !window.electronAPI.updater) return
  var nasStatus = 'idle'
  try { window.electronAPI.updater.getStatus().then(function (s) { nasStatus = (s && s.status) || 'idle' }) } catch (e) {}
  try { window.electronAPI.updater.onStatusChanged(function (s) { nasStatus = (s && s.status) || 'idle' }) } catch (e) {}
  // 捕获阶段拦截（React 委托监听在冒泡阶段，这里先拦截不触发 React onClick）
  document.addEventListener('click', function (e) {
    var target = e.target
    while (target && target !== document.body && target.tagName !== 'BUTTON') target = target.parentNode
    if (!target || target.tagName !== 'BUTTON') return
    var t = (target.textContent || '').trim()
    if (nasStatus === 'available' && t.indexOf('前往下载') !== -1) {
      e.preventDefault()
      e.stopPropagation()
      try { window.electronAPI.updater.installWhenIdle() } catch (err) {}
    } else if (nasStatus === 'downloaded' && t.indexOf('空闲时更新') !== -1) {
      e.preventDefault()
      e.stopPropagation()
      target.textContent = '更新完成，请重启 Proma'
      target.disabled = true
    }
  }, true)
})();
`
/** 拦截生成产物的两个失效 import，重定向到 Proma 源码 */
const promaSrcRedirect = {
  name: 'proma-src-redirect',
  setup(build: any): void {
    build.onResolve({ filter: /^@proma\/shared$/ }, () => ({ path: SHARED_ENTRY }))
    build.onResolve({ filter: /^@proma\/shared\// }, (args: { path: string }) => {
      // @proma/shared 子路径（如 @proma/shared/types）→ packages/shared/src/<rest>.ts
      const rest = args.path.slice('@proma/shared/'.length)
      return { path: join(PROMA_SRC, 'packages/shared/src', rest.endsWith('.ts') ? rest : `${rest}.ts`) }
    })
    build.onResolve({ filter: /^\.\.\/types$/ }, () => ({ path: TYPES_ENTRY }))
  },
}

async function main(): Promise<void> {
  console.log(`[build-preload-bundle] 入口: ${ENTRY}`)
  console.log(`[build-preload-bundle] @proma/shared → ${SHARED_ENTRY}`)
  console.log(`[build-preload-bundle] ../types → ${TYPES_ENTRY}`)

  await mkdir(OUT_DIR, { recursive: true })

  try {
    const result = await Bun.build({
      entrypoints: [ENTRY],
      outdir: OUT_DIR,
      naming: 'web-preload.js',
      format: 'iife',
      target: 'browser',
      sourcemap: 'none',
      plugins: [promaSrcRedirect],
    })
    if (!result.success) {
      console.error('[build-preload-bundle] ❌ 构建失败:')
      for (const log of result.logs) console.error('  ', log.message ?? log)
      process.exit(1)
    }
    const out = result.outputs[0]
    console.log(`[build-preload-bundle] ✅ 已生成 ${out.path}`)
    // 追加 NAS 自更新 UI patch（可在 bundle 后直接读取文件追加）
    const { readFile, writeFile } = await import('node:fs/promises')
    const bundlePath = out.path
    let bundle = await readFile(bundlePath, 'utf8')
    if (!bundle.includes('NAS 自更新 UI patch')) {
      bundle += NAS_UI_PATCH
      await writeFile(bundlePath, bundle, 'utf8')
      console.log('[build-preload-bundle] ✅ 已追加 NAS 自更新 UI patch')
    } else {
      console.log('[build-preload-bundle] NAS 自更新 UI patch 已存在，跳过')
    }
    const size = (await import('node:fs/promises')).stat(out.path).then((s) => s.size)
    console.log(`[build-preload-bundle] 大小: ${(await size / 1024).toFixed(1)} KB`)
  } catch (err) {
    console.error('[build-preload-bundle] 构建异常:', err)
    console.error('[build-preload-bundle] 提示: 若 Bun.build 解析失败，可改用 esbuild（bun add -D esbuild 后重试）')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[build-preload-bundle] 失败:', err)
  process.exit(1)
})

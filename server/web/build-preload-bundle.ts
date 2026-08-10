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

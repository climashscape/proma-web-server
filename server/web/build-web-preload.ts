/**
 * build-web-preload.ts — 从 Proma 源码 preload/index.ts 生成浏览器版 web-preload
 *
 * 策略（阶段 2 核心：机械映射，零手写）：
 *  - 把 `import { contextBridge, ipcRenderer, webUtils } from 'electron'`
 *    替换为 `import { contextBridge, ipcRenderer, webUtils } from './preload-bridge'`
 *  - 其余 2807 行保持原样：invoke 直通 / on/once 订阅 / sendSync 由 bridge 兼容
 *  - contextBridge.exposeInMainWorld 由 bridge 实现（window 赋值）
 *
 * 产物：web/preload.ts（浏览器端 electronAPI 定义，供阶段 4 renderer 注入）
 *
 * 用法:
 *   PROMA_SRC=/opt/Proma bun run web/build-web-preload.ts
 *   PROMA_SRC=... bun run web/build-web-preload.ts --out /tmp/web-index.ts   # 指定输出
 */

import { join, dirname, basename } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMA_SRC = process.env.PROMA_SRC
if (!PROMA_SRC) {
  console.error('[build] 必须设置 PROMA_SRC 环境变量指向 Proma 源码目录')
  process.exit(1)
}
const SRC_FILE = join(PROMA_SRC, 'apps/electron/src/preload/index.ts')

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const OUT_FILE = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : join(__dirname, 'preload.ts')

const OLD_IMPORT = "import { contextBridge, ipcRenderer, webUtils } from 'electron'"
const NEW_IMPORT = "import { contextBridge, ipcRenderer, webUtils } from './preload-bridge'"

// 特殊重写（Web 模式语义修正）：剪贴板写入直接走浏览器 navigator.clipboard。
// 原因：stub clipboard.writeText 是 no-op（server 侧无剪贴板），但 renderer 的
// copyTextToClipboard 只在 native 路径**抛错**时才 fallback；no-op 导致"假成功"——
// 复制按钮无效果。浏览器侧直接写剪贴板（127.0.0.1 为 secure context，navigator.clipboard 可用）。
const CLIPBOARD_OLD = `  writeClipboardText: (text: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WRITE_CLIPBOARD_TEXT, text)
  },`
const CLIPBOARD_NEW = `  writeClipboardText: async (text: string) => {
    // Web 模式：直接写浏览器剪贴板；非 secure context（局域网 http://<ip>）navigator.clipboard 不可用 → execCommand 降级
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
    } catch {
      /* 权限拒绝/非 secure context，走降级 */
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    if (!ok) throw new Error('复制失败：浏览器上下文不支持剪贴板（请使用 HTTPS 访问或重试）')
  },`

// 特殊重写（Web 模式语义修正）：openFileOrFolderDialog 改用浏览器原生文件选择器。
// 原因：Web 模式下 @proma/electron-stub 的 dialog 是桩（showOpenDialog 恒返回 canceled），
// 导致"附加文件或文件夹"点击静默无反应（实测返回 {files:[],directories:[]}）。
// 浏览器沙箱无法提供文件磁盘绝对路径，但 File 对象可读内容——与桌面语义对齐：
// 小文件读 base64（FileDialogFile），超大文件（>100MB，MAX_ATTACHMENT_SIZE）返回 largeFiles
// （path 为空占位），目录选择（directories）受浏览器安全限制在 Web 版暂不可用。
const OPEN_DIALOG_OLD = `  openFileOrFolderDialog: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE_OR_FOLDER_DIALOG)
  },`
const OPEN_DIALOG_NEW = `  openFileOrFolderDialog: () => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', async () => {
        input.remove()
        const picked = input.files ? Array.from(input.files) : []
        if (picked.length === 0) {
          resolve({ files: [], directories: [] })
          return
        }
        const files: any[] = []
        const largeFiles: any[] = []
        const skippedFiles: any[] = []
        // 单文件与多文件累积均以服务端实际 MAX_MSG_BYTES（ready 帧下发）为基准
        const frameLimit = (ipcRenderer.maxMsgBytes || 4 * 1024 * 1024)
        const maxBase64 = frameLimit - 8192
        const MAX_SIZE = 100 * 1024 * 1024 // 超大文件占位阈值（保留原语义：进 largeFiles）
        let accBase64 = 0
        for (const f of picked) {
          const mediaType = f.type || 'application/octet-stream'
          try {
            if (f.size > MAX_SIZE) {
              largeFiles.push({ filename: f.name, mediaType, size: f.size, path: '' })
              continue
            }
            // 读取前按 f.size 估算 base64 长度（base64 膨胀 ~4/3），超限/累计超限提前跳过，避免整读大文件进内存
            const estBase64 = Math.ceil(f.size / 3) * 4
            if (estBase64 > maxBase64 || accBase64 + estBase64 > maxBase64) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: '超过 Web 版消息上限（约 ' + Math.max(1, Math.floor((frameLimit * 0.75) / 1024 / 1024)) + 'MB）' })
              continue
            }
            const data = await new Promise<string>((res, rej) => {
              const reader = new FileReader()
              reader.onload = () => res(String(reader.result).split(',')[1] || '')
              reader.onerror = () => rej(reader.error || new Error('read failed'))
              reader.readAsDataURL(f)
            })
            // 单文件超限或累计超限（多文件将打包进同一 invoke 帧）→ 提前跳过并提示
            if (data.length > maxBase64 || accBase64 + data.length > maxBase64) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: '超过 Web 版消息上限（约 ' + Math.max(1, Math.floor((frameLimit * 0.75) / 1024 / 1024)) + 'MB）' })
              continue
            }
            accBase64 += data.length
            files.push({ filename: f.name, mediaType, data, size: f.size })
          } catch (e) {
            skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: 'unreadable', message: String(e) })
          }
        }
        const result: any = { files, directories: [] }
        if (largeFiles.length > 0) result.largeFiles = largeFiles
        if (skippedFiles.length > 0) result.skippedFiles = skippedFiles
        resolve(result)
      })
      input.click()
    })
  },`

// 特殊重写（Web 模式语义修正）：openFileDialog（右侧「添加文件」+ Chat 附件）
// 同样改用浏览器原生文件选择器。原因与 openFileOrFolderDialog 相同：
// electron-stub 的 dialog 是桩，点击静默无反应。
const OPEN_FILE_DIALOG_OLD = `  openFileDialog: () => {
    return ipcRenderer.invoke(CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG)
  },`
const OPEN_FILE_DIALOG_NEW = `  openFileDialog: () => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', async () => {
        input.remove()
        const picked = input.files ? Array.from(input.files) : []
        if (picked.length === 0) {
          resolve({ files: [], directories: [] })
          return
        }
        const files: any[] = []
        const largeFiles: any[] = []
        const skippedFiles: any[] = []
        // 单文件与多文件累积均以服务端实际 MAX_MSG_BYTES（ready 帧下发）为基准
        const frameLimit = (ipcRenderer.maxMsgBytes || 4 * 1024 * 1024)
        const maxBase64 = frameLimit - 8192
        const MAX_SIZE = 100 * 1024 * 1024 // 超大文件占位阈值（保留原语义：进 largeFiles）
        let accBase64 = 0
        for (const f of picked) {
          const mediaType = f.type || 'application/octet-stream'
          try {
            if (f.size > MAX_SIZE) {
              largeFiles.push({ filename: f.name, mediaType, size: f.size, path: '' })
              continue
            }
            // 读取前按 f.size 估算 base64 长度（base64 膨胀 ~4/3），超限/累计超限提前跳过，避免整读大文件进内存
            const estBase64 = Math.ceil(f.size / 3) * 4
            if (estBase64 > maxBase64 || accBase64 + estBase64 > maxBase64) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: '超过 Web 版消息上限（约 ' + Math.max(1, Math.floor((frameLimit * 0.75) / 1024 / 1024)) + 'MB）' })
              continue
            }
            const data = await new Promise<string>((res, rej) => {
              const reader = new FileReader()
              reader.onload = () => res(String(reader.result).split(',')[1] || '')
              reader.onerror = () => rej(reader.error || new Error('read failed'))
              reader.readAsDataURL(f)
            })
            // 单文件超限或累计超限（多文件将打包进同一 invoke 帧）→ 提前跳过并提示
            if (data.length > maxBase64 || accBase64 + data.length > maxBase64) {
              skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: '超过 Web 版消息上限（约 ' + Math.max(1, Math.floor((frameLimit * 0.75) / 1024 / 1024)) + 'MB）' })
              continue
            }
            accBase64 += data.length
            files.push({ filename: f.name, mediaType, data, size: f.size })
          } catch (e) {
            skippedFiles.push({ filename: f.name, mediaType, size: f.size, path: '', reason: 'unreadable', message: String(e) })
          }
        }
        const result: any = { files, directories: [] }
        if (largeFiles.length > 0) result.largeFiles = largeFiles
        if (skippedFiles.length > 0) result.skippedFiles = skippedFiles
        resolve(result)
      })
      input.click()
    })
  },`

// 特殊重写（Web 模式语义修正）：openFolderDialog 在 Web 下无法获取文件夹磁盘路径，
// 返回 null 并显示可见提示（避免静默无反应）。被 8 处调用（附加文件夹/选项目/移动等），
// 返回 null 时前端均安全 return。
const OPEN_FOLDER_DIALOG_OLD = `  openFolderDialog: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG)
  },`
const OPEN_FOLDER_DIALOG_NEW = `  openFolderDialog: () => {
    console.warn('[Web] openFolderDialog 暂不支持：浏览器安全限制无法获取文件夹磁盘路径')
    try {
      const div = document.createElement('div')
      div.textContent = 'Web 版暂不支持选择文件夹（浏览器安全限制无法获取磁盘路径），可改用添加文件或在工作区放置目录'
      div.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#1f2937;color:#fbbf24;padding:10px 16px;border-radius:10px;border:1px solid #4b5563;font:13px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.35);max-width:80%'
      document.body.appendChild(div)
      setTimeout(() => div.remove(), 4000)
    } catch {}
    return Promise.resolve(null)
  },`

async function main(): Promise<void> {
  console.log(`[build-web-preload] 读取 ${SRC_FILE}`)
  // 换行归一化：Windows checkout（autocrlf）会得到 CRLF，多行模板匹配需统一为 LF（Linux 生产环境为 LF）
  const src = (await readFile(SRC_FILE, 'utf8')).replace(/\r\n/g, '\n')
  const lines = src.split('\n')

  // 生成头
  const header = [
    '// ============================================================================',
    '// ⚠️ 本文件由 build-web-preload.ts 自动生成，请勿手工编辑（上游更新时重新生成）',
    `// 来源: ${basename(SRC_FILE)} (Proma @ ${PROMA_SRC})`,
    `// 生成时间: ${new Date().toISOString()}`,
    '// 转换: electron import → ./preload-bridge（WS IPC 桥，浏览器端 electronAPI）',
    '// 说明: invoke 直通 WS request 通道；on/once 订阅映射 WS event 通道；',
    '//       sendSync 由 bridge 兼容（乐观返回 + 异步 invoke）；webUtils 降级为 file.path',
    '// ============================================================================',
    '',
  ]

  const body: string[] = []
  let replaced = 0
  let typeImportLines = 0
  let clipboardRewritten = 0
  let dialogRewritten = 0
  let fileDialogRewritten = 0
  let folderDialogRewritten = 0
  for (const line of lines) {
    if (line.trim() === OLD_IMPORT) {
      body.push(NEW_IMPORT)
      replaced++
      continue
    }
    if (line.startsWith('import type ')) {
      typeImportLines++
    }
    body.push(line)
  }

  if (replaced !== 1) {
    console.error(`[build-web-preload] ❌ electron import 替换数量异常: ${replaced}（期望 1）。上游结构可能变化，请检查 ${SRC_FILE}`)
    process.exit(1)
  }

  // 特殊重写（多行块替换，需要先 join）；任一重写未命中即 fail（上游 preload 结构变化时显式报错，
  // 而非静默产出"剪贴板假成功/文件选择无反应"的降级产物）
  let joined = body.join('\n')
  if (joined.includes(CLIPBOARD_OLD)) {
    joined = joined.replace(CLIPBOARD_OLD, CLIPBOARD_NEW)
    clipboardRewritten++
  }
  if (joined.includes(OPEN_DIALOG_OLD)) {
    joined = joined.replace(OPEN_DIALOG_OLD, OPEN_DIALOG_NEW)
    dialogRewritten++
  }
  if (joined.includes(OPEN_FILE_DIALOG_OLD)) {
    joined = joined.replace(OPEN_FILE_DIALOG_OLD, OPEN_FILE_DIALOG_NEW)
    fileDialogRewritten++
  }
  if (joined.includes(OPEN_FOLDER_DIALOG_OLD)) {
    joined = joined.replace(OPEN_FOLDER_DIALOG_OLD, OPEN_FOLDER_DIALOG_NEW)
    folderDialogRewritten++
  }

  if (clipboardRewritten !== 1 || joined.includes(CLIPBOARD_OLD)) {
    console.error(`[build-web-preload] ❌ 剪贴板重写数量异常: ${clipboardRewritten} 或存在未替换残留。上游 preload 结构可能变化，请检查 ${SRC_FILE}`)
    process.exit(1)
  }
  if (dialogRewritten !== 1 || joined.includes(OPEN_DIALOG_OLD)) {
    console.error(`[build-web-preload] ❌ openFileOrFolderDialog 重写数量异常: ${dialogRewritten} 或存在未替换残留。上游 preload 结构可能变化，请检查 ${SRC_FILE}`)
    process.exit(1)
  }
  if (fileDialogRewritten !== 1 || joined.includes(OPEN_FILE_DIALOG_OLD)) {
    console.error(`[build-web-preload] ❌ openFileDialog 重写数量异常: ${fileDialogRewritten} 或存在未替换残留。上游 preload 结构可能变化，请检查 ${SRC_FILE}`)
    process.exit(1)
  }
  if (folderDialogRewritten !== 1 || joined.includes(OPEN_FOLDER_DIALOG_OLD)) {
    console.error(`[build-web-preload] ❌ openFolderDialog 重写数量异常: ${folderDialogRewritten} 或存在未替换残留。上游 preload 结构可能变化，请检查 ${SRC_FILE}`)
    process.exit(1)
  }

  const out = [...header, joined].join('\n')
  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, out, 'utf8')

  const stats = {
    srcLines: lines.length,
    outLines: body.length,
    typeImportLines,
    clipboardRewritten,
    dialogRewritten,
    fileDialogRewritten,
    folderDialogRewritten,
    ipcInvoke: (joined.match(/ipcRenderer\.invoke/g) ?? []).length,
    ipcOn: (joined.match(/ipcRenderer\.on\(/g) ?? []).length,
    ipcOnce: (joined.match(/ipcRenderer\.once\(/g) ?? []).length,
    ipcSendSync: (joined.match(/ipcRenderer\.sendSync/g) ?? []).length,
    webUtils: (joined.match(/webUtils\./g) ?? []).length,
  }
  console.log(`[build-web-preload] ✅ 已生成 ${OUT_FILE}`)
  console.log('[build-web-preload] 统计:', JSON.stringify(stats, null, 2))
}

main().catch((err) => {
  console.error('[build-web-preload] 失败:', err)
  process.exit(1)
})

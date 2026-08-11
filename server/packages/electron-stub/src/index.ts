/**
 * electron-stub.ts — Proma Web 服务化 PoC
 *
 * 在纯 Bun/Node 环境下替代 Electron API 的最小 stub。
 * 目的：让 main 进程的 ipc.ts + lib/ 链可以加载（import 不炸）、
 *       registerIpcHandlers() 可以注册、handler 可以被 WS 桥 invoke。
 *
 * 设计要点：
 * - ipcMain.handle(channel, fn) 把 handler 存入注册表，供 server 侧 dispatch
 * - handler 收到的 fake event.sender.send(channel, ...payload) → 全局广播
 *   （天然实现 main→renderer 事件推送，agent 流式等）
 * - app.getPath('userData') 返回隔离目录（默认 ~/.proma-web），不污染真实 ~/.proma
 */

import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes, createHash, randomUUID } from 'node:crypto'

// ===================== 全局注册表（server.ts 通过这里做 IPC 桥） =====================

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>()
const onHandlers = new Map<string, Set<(...args: unknown[]) => void>>()

type BroadcastFn = (channel: string, ...payload: unknown[]) => void
let broadcastFn: BroadcastFn = () => {}

/** 由 server 注入：handler 内 event.sender.send → WS 广播 */
export function setEventBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn
}

/** 按 channel 查找 invoke handler（server dispatch 用） */
export function getInvokeHandler(channel: string): ((...args: unknown[]) => unknown) | undefined {
  return invokeHandlers.get(channel)
}

/** 已注册的全部 channel 列表 */
export function listRegisteredChannels(): string[] {
  return [...invokeHandlers.keys()].sort()
}

/** 调用 handler（server 用），自动包裹 fake event */
export async function invokeChannel(channel: string, args: unknown[]): Promise<unknown> {
  const fn = invokeHandlers.get(channel)
  if (!fn) throw new Error(`[stub] 未注册的 channel: ${channel}`)
  return fn(createEvent(), ...(args ?? []))
}

// ===================== fake event =====================

function createEvent(): any {
  // sender 对齐 WebContents 最小表面（agent-service 会把 event.sender 当 webContents 用：
  // once('destroyed') 注册回收钩子 / isDestroyed() 判断 / send() 推送事件）
  const sender = {
    send: (ch: string, ...payload: unknown[]) => {
      broadcastFn(ch, ...payload)
    },
    on: () => sender,
    once: () => sender,
    removeListener: () => sender,
    removeAllListeners: () => sender,
    isDestroyed: () => false,
    getURL: () => '',
    getTitle: () => 'Proma',
    getType: () => 'window',
    executeJavaScript: () => Promise.resolve(undefined),
    setWindowOpenHandler: () => {},
    openDevTools: () => {},
  }
  return {
    sender,
    reply: (ch: string, ...payload: unknown[]) => {
      broadcastFn(ch, ...payload)
    },
    returnValue: undefined,
    preventDefault: () => {},
  }
}

// ===================== ipcMain =====================

export const ipcMain = {
  handle(channel: string, fn: (...args: unknown[]) => unknown) {
    invokeHandlers.set(channel, fn)
    return ipcMain
  },
  on(channel: string, fn: (...args: unknown[]) => void) {
    if (!onHandlers.has(channel)) onHandlers.set(channel, new Set())
    onHandlers.get(channel)!.add(fn)
    return ipcMain
  },
  once(channel: string, fn: (...args: unknown[]) => void) {
    return ipcMain.on(channel, fn)
  },
  removeHandler(channel: string) {
    invokeHandlers.delete(channel)
  },
  removeAllListeners(channel?: string) {
    if (channel) onHandlers.delete(channel)
    else onHandlers.clear()
  },
  removeListener(channel: string, fn: (...args: unknown[]) => void) {
    onHandlers.get(channel)?.delete(fn)
  },
}

// ===================== app =====================

const USER_DATA_DIR = process.env.PROMA_WEB_USER_DATA || join(homedir(), '.proma-web')
const LOGS_DIR = join(USER_DATA_DIR, 'logs')
const SESSION_DATA_DIR = join(USER_DATA_DIR, 'session-data')

const APP_PATHS: Record<string, string> = {
  home: homedir(),
  appData: join(homedir(), '.config'),
  userData: USER_DATA_DIR,
  sessionData: SESSION_DATA_DIR,
  temp: tmpdir(),
  logs: LOGS_DIR,
  cache: join(USER_DATA_DIR, 'Cache'),
  exe: process.execPath,
  module: __filename,
  desktop: join(homedir(), 'Desktop'),
  documents: join(homedir(), 'Documents'),
  downloads: join(homedir(), 'Downloads'),
  pictures: join(homedir(), 'Pictures'),
  music: join(homedir(), 'Music'),
  videos: join(homedir(), 'Videos'),
  roaming: USER_DATA_DIR,
}

export const app = {
  isPackaged: false,
  isReady: () => true,
  getName: () => 'Proma',
  getVersion: () => '0.16.38',
  getLocale: () => 'zh-CN',
  getPath: (name: string) => APP_PATHS[name] ?? USER_DATA_DIR,
  setPath: (_name: string, _path: string) => {},
  setName: (_name: string) => {},
  getAppPath: () => resolve(process.cwd()),
  requestSingleInstanceLock: () => true,
  quit: () => {},
  exit: () => {},
  relaunch: () => {},
  focus: () => {},
  show: () => {},
  hide: () => {},
  // 阶段 3 补全：Web 模式无 Dock 角标，no-op 避免 dock-badge:set-count handler 报错
  setBadgeCount: () => false,
  getBadgeCount: () => 0,
  on: () => app,
  once: () => app,
  removeListener: () => app,
  whenReady: () => Promise.resolve(app),
  commandLine: {
    appendSwitch: () => {},
    appendArgument: () => {},
    hasSwitch: () => false,
    getSwitchValue: () => '',
  },
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAppUserModelId: () => {},
  getAppMetrics: () => [],
  addRecentDocument: () => {},
}

// ===================== BrowserWindow =====================

const _windows = new Set<any>()

/**
 * Web 模式 fallback 主窗口。
 *
 * 桌面版语音链路用 BrowserWindow.fromWebContents(event.sender) 反查发起窗口，
 * 拿不到就 throw（START handler → '语音输入窗口不存在'）。Web 模式没有真实窗口，
 * 这里返回一个全局 fake window，让 START 链路能继续走到 doubao-asr-service。
 */
let _fallbackWindow: any = null

export class BrowserWindow {
  static getAllWindows(): any[] {
    return [..._windows]
  }
  static getFocusedWindow(): any | null {
    return _fallbackWindow
  }
  static getWindowById(_id: number): any | null {
    return _fallbackWindow
  }
  static fromWebContents(_wc: any): any | null {
    return _fallbackWindow ?? (_fallbackWindow = new BrowserWindow({ show: false }))
  }

  webContents: any
  id: number
  isDestroyed = () => false
  isVisible = () => true
  isFocused = () => false
  isMinimized = () => false
  isMaximized = () => false
  isFullScreen = () => false
  getBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 })
  getContentBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 })
  getSize = () => [1280, 800]
  getContentSize = () => [1280, 800]
  getPosition = () => [0, 0]
  getTitle = () => 'Proma'
  setTitle = () => {}
  loadURL = () => Promise.resolve()
  loadFile = () => Promise.resolve()
  show = () => {}
  hide = () => {}
  focus = () => {}
  close = () => {}
  destroy = () => {}
  minimize = () => {}
  maximize = () => {}
  unmaximize = () => {}
  restore = () => {}
  showInactive = () => {}
  setVisibleOnAllWorkspaces = () => {}
  setBounds = () => {}
  setSize = () => {}
  setContentSize = () => {}
  setPosition = () => {}
  setMinimumSize = () => {}
  setMaximumSize = () => {}
  setResizable = () => {}
  setMovable = () => {}
  setAlwaysOnTop = () => {}
  setSkipTaskbar = () => {}
  setMenuBarVisibility = () => {}
  setAutoHideMenuBar = () => {}
  removeMenu = () => {}
  setMenu = () => {}
  setBackgroundColor = () => {}
  setIcon = () => {}
  webContentsSend = (_channel: string, ..._args: unknown[]) => {}
  on = () => this
  once = () => this
  removeListener = () => this
  static on = () => BrowserWindow
  static once = () => BrowserWindow
  static removeListener = () => BrowserWindow
  static removeAllListeners = () => {}

  constructor(opts?: any) {
    this.id = Math.floor(Math.random() * 1e9)
    this.webContents = {
      id: this.id,
      send: (channel: string, ...payload: unknown[]) => {
        broadcastFn(channel, ...payload)
      },
      on: () => this.webContents,
      once: () => this.webContents,
      removeListener: () => this.webContents,
      removeAllListeners: () => this.webContents,
      executeJavaScript: () => Promise.resolve(undefined),
      loadURL: () => Promise.resolve(),
      loadFile: () => Promise.resolve(),
      isDestroyed: () => false,
      isLoading: () => false,
      setWindowOpenHandler: () => {},
      openDevTools: () => {},
      closeDevTools: () => {},
      getURL: () => '',
      getTitle: () => 'Proma',
      getType: () => 'window',
      // 语音输入链路：installVoiceDictationMediaPermissions 会调用
      // session.setPermissionCheckHandler / setPermissionRequestHandler。
      // Web 模式媒体权限由浏览器 getUserMedia 管理，这里 no-op。
      session: {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: () => {},
      },
    }
    if (opts?.show !== false) _windows.add(this)
  }
}

// ===================== dialog / shell / clipboard / nativeImage =====================

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => undefined,
  showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  showSaveDialogSync: () => undefined,
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showErrorBox: (_title: string, _content: string) => {},
}

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder: (_path: string) => {},
  trashItem: async () => {},
  beep: () => {},
}

export const clipboard = {
  writeText: (_text: string) => {},
  readText: () => '',
  clear: () => {},
  write: () => {},
  read: () => ({ getImage: () => undefined }),
  writeImage: () => {},
  readImage: () => nativeImage.createEmpty(),
  availableFormats: () => [],
}

export const nativeImage = {
  createEmpty: () => ({ getSize: () => ({ width: 0, height: 0 }), toDataURL: () => '', isEmpty: () => true, getBitmap: () => Buffer.alloc(0), resize: () => nativeImage.createEmpty() }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromBitmap: () => nativeImage.createEmpty(),
}

// ===================== nativeTheme / Menu / Tray / screen / protocol =====================

export const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'system',
  on: () => nativeTheme,
  once: () => nativeTheme,
  removeListener: () => nativeTheme,
}

export const Menu = {
  buildFromTemplate: (_template: unknown[]) => ({
    popup: () => {},
    closePopup: () => {},
    append: () => {},
    insert: () => {},
    items: [],
  }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
}

export class Tray {
  constructor(_image?: unknown) {}
  setToolTip = () => {}
  setTitle = () => {}
  setContextMenu = () => {}
  setImage = () => {}
  on = () => this
  once = () => this
  destroy = () => {}
  isDestroyed = () => false
}

export const screen = {
  getPrimaryDisplay: () => ({ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, workAreaSize: { width: 1920, height: 1040 }, size: { width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0, internal: true, touchSupport: 'unknown', accelerometerSupport: 'unknown' }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  on: () => screen,
  once: () => screen,
  removeListener: () => screen,
}

export const protocol = {
  registerSchemesAsPrivileged: (_schemes: unknown[]) => {},
  handle: (_scheme: string, _handler: unknown) => {},
  unhandle: (_scheme: string) => {},
  registerFileProtocol: (_scheme: string, _handler: unknown) => {},
  interceptFileProtocol: (_scheme: string, _handler: unknown) => {},
  isProtocolHandled: async () => false,
}

// ===================== safeStorage / power / shortcuts / prefs / Notification / net =====================

// 安全密钥：优先环境变量 PROMA_WEB_SAFE_KEY；未设置时从 <userData>/.safe-key 读取或生成（持久化，重启可解密）
function resolveSafeKey(): Buffer {
  const fromEnv = process.env.PROMA_WEB_SAFE_KEY
  if (fromEnv) {
    return createHash('sha256').update(fromEnv).digest()
  }
  const keyFile = join(USER_DATA_DIR, '.safe-key')
  try {
    if (existsSync(keyFile)) {
      const raw = readFileSync(keyFile, 'utf8').trim()
      if (raw) return createHash('sha256').update(raw).digest()
    }
    // 生成并持久化（保证重启后已加密数据可解密）
    mkdirSync(USER_DATA_DIR, { recursive: true })
    const secret = randomUUID() + randomUUID()
    writeFileSync(keyFile, secret, { mode: 0o600 })
    console.log('[stub] 已生成持久化安全密钥:', keyFile)
    return createHash('sha256').update(secret).digest()
  } catch (err) {
    // 无法写文件时降级为进程内随机 key（重启后旧密文不可解，仅 PoC 可接受）
    console.warn('[stub] 无法持久化安全密钥，使用进程内随机 key:', err instanceof Error ? err.message : err)
    return createHash('sha256').update(randomUUID()).digest()
  }
}

const SAFE_STORAGE_KEY = resolveSafeKey()

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', SAFE_STORAGE_KEY, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc])
  },
  decryptString: (buf: Buffer): string => {
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', SAFE_STORAGE_KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  },
}

export const powerMonitor = {
  on: () => powerMonitor,
  once: () => powerMonitor,
  removeListener: () => powerMonitor,
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
}

export const powerSaveBlocker = {
  start: () => 0,
  stop: (_id: number) => {},
  isStarted: (_id: number) => false,
}

export const globalShortcut = {
  register: () => false,
  registerAll: () => [],
  unregister: () => {},
  unregisterAll: () => {},
  isRegistered: () => false,
}

export const systemPreferences = {
  getMediaAccessStatus: (_type: string) => 'not-determined' as const,
  askForMediaAccess: async () => true,
  getUserDefault: () => undefined,
  setUserDefault: () => {},
  getAccentColor: () => '#007aff',
  isDarkMode: () => true,
}

export class Notification {
  static isSupported = () => true
  constructor(_opts?: unknown) {}
  show = () => {}
  close = () => {}
  on = () => this
  once = () => this
  removeListener = () => this
  static on = () => Notification
}

export const net = {
  fetch: (...args: unknown[]) => (globalThis as any).fetch(...(args as [any, any])),
  request: () => {
    throw new Error('net.request 未在 PoC stub 中实现')
  },
  isOnline: () => true,
}

// ===================== 其他可能用到的小项 =====================

export const desktopCapturer = {
  getSources: async () => [],
}

export const contextBridge = {
  exposeInMainWorld: (_key: string, _api: unknown) => {},
}

export const webContents = {
  getAllWebContents: () => [],
  // 阶段 3 补全：agent-service registerWebContents 直接以 webContents 为 wc 调用 once/on（no-op）
  on: (_channel: string, _fn: (...args: unknown[]) => void) => webContents,
  once: (_channel: string, _fn: (...args: unknown[]) => void) => webContents,
  removeListener: (_channel: string, _fn: (...args: unknown[]) => void) => webContents,
  removeAllListeners: (_channel?: string) => webContents,
}

export const ipcRenderer = {
  on: (_channel: string, _fn: (...args: unknown[]) => void) => ipcRenderer,
  once: (_channel: string, _fn: (...args: unknown[]) => void) => ipcRenderer,
  removeListener: (_channel: string, _fn: (...args: unknown[]) => void) => ipcRenderer,
  removeAllListeners: (_channel?: string) => ipcRenderer,
  invoke: async (_channel: string, ..._args: unknown[]) => undefined,
  send: (_channel: string, ..._args: unknown[]) => {},
  sendSync: (_channel: string, ..._args: unknown[]) => undefined,
}

export const crashReporter = { start: () => {} }

export const autoUpdater = {
  on: () => autoUpdater,
  checkForUpdates: () => {},
  quitAndInstall: () => {},
}

export default {
  app,
  BrowserWindow,
  dialog,
  shell,
  clipboard,
  nativeImage,
  nativeTheme,
  Menu,
  Tray,
  screen,
  protocol,
  safeStorage,
  powerMonitor,
  powerSaveBlocker,
  globalShortcut,
  systemPreferences,
  Notification,
  net,
  ipcMain,
  ipcRenderer,
  desktopCapturer,
  contextBridge,
  webContents,
  crashReporter,
  autoUpdater,
}

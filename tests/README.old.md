# Proma Web Server（阶段 2/3：WS IPC 桥 + preload 映射 + renderer web 化）

把 Proma（Electron AI Agent）改造成 Web 应用的服务层：浏览器访问原生 UI，复用 main 进程
`ipc.ts` + `lib/` 全部业务逻辑，不重写。部署目标：飞牛 OS NAS 24/7 运行。

```
[浏览器] ⇄ HTTP(renderer 静态UI:6810) + WebSocket(/ws?token=) ⇄ [Bun server.ts]
              ↑ web-preload.js（注入）                    ├── @proma/electron-stub（独立包）
              ↑ token-gate（登录遮罩）                    ├── ipc.ts（复用不改，源码级 patch import）
                                                          └── lib/ 服务层（复用）
```

## 阶段 3（renderer web 化）说明

- renderer 是 Vite 纯静态产物（`bun run build:renderer` → `dist/renderer/`），**不改 Proma renderer 源码**；
- `web/preload.ts`（preload 2807 行映射）由 `web/build-preload-bundle.ts` 用 Bun.build 打包为
  `public/web-preload.js`（IIFE，浏览器平台）；server.ts 静态服务返回 renderer index.html 时注入：
  `web-preload.js`（在 React 启动前把 `window.electronAPI` 挂到 window，等价 preload contextBridge）+
  token-gate（见下）；
- **token 获取（最小可用方案）**：URL `?token=` 自动转存 `localStorage.proma_web_token` 并清除 URL 参数
  （缓解 #25 URL 泄露）；无 token 时显示登录遮罩，输入后存 localStorage 刷新。阶段 4 可升级为 cookie/session；
- sendSync 2 处（`updateSettingsSync`/`saveScratchPadSync`）由 bridge 乐观返回，renderer 零改动；
- 浏览器冒烟：`browser-smoke.ts`（playwright headless chromium）验证 `window.electronAPI` + 真实 invoke。

## 目录结构

```
server-test/
├── server.ts                        # 入口：HTTP + WS IPC 桥（request/event 两类通道）
├── protocol.ts                      # WS 协议定义（帧类型/错误码/心跳参数）
├── logger.ts                        # 结构化 JSON 日志
├── electron-stub.ts                 # re-export 薄壳（→ packages/electron-stub）
├── packages/electron-stub/          # @proma/electron-stub 独立包（Electron API stub）
├── web/
│   ├── preload-bridge.ts            # 浏览器端 WS 桥（对齐 ipcRenderer API；状态通知/懒连接）
│   ├── preload.ts                   # 生成产物：preload/index.ts 2807 行的浏览器版映射
│   ├── build-web-preload.ts         # 生成脚本（上游更新时重新生成 preload.ts）
│   ├── build-preload-bundle.ts      # 阶段 3：打包 preload.ts → public/web-preload.js（Bun.build）
│   └── bridge-test.ts               # bridge 运行态测试（含真实事件断言）
├── browser-smoke.ts                # 阶段 3：headless chromium 冒烟（window.electronAPI + invoke）
├── scripts/
│   └── patch-proma.sh               # ProMA 源码级 electron stub patch（apply/undo/status）
├── client-test.ts                   # WS 协议层测试客户端（基础 + --extra）
├── verify.sh                        # 全量回归（HTTP + WS + 浏览器冒烟）
├── public/                          # 静态 UI（renderer 产物 + web-preload.js + poc.html）
├── .env.example                     # 环境变量示例
└── README.md
```

## 快速开始（WSL Ubuntu）

前置：WSL 已装 bun 1.3.14+；Proma 源码 `<proma-src>`；运行副本 `/opt/proma-web-server`
（Windows 侧 `workspace-files/server-test/` 为源，`verify.sh` 自动同步）。

```bash
# 1. 一次性：electron stub 源码级 patch（import 'electron' → '@proma/electron-stub'）
cd /opt/proma-web-server && bash scripts/patch-proma.sh apply

# 2. 启动（安全默认：token 必填、127.0.0.1）
PROMA_WEB_TOKEN=$(openssl rand -hex 32) bun run server.ts

# 2b. 浏览器访问（token 经 URL 自动转存 localStorage；无 token 时页面显示登录遮罩）
# 打开 http://127.0.0.1:6810/?token=<你的token>  或  先访问页面在遮罩里输入 token

# 3. 回归验证（自动同步 Windows 侧代码 + 随机 token + 全量测试）
bash verify.sh            # 快速（含浏览器冒烟，需 playwright）
bash verify.sh --extra    # 全量（+互斥/大消息/bridge 心跳/extended）

# 3b. 浏览器冒烟首次安装：
cd /opt/proma-web-server && bun add playwright && bunx playwright install chromium --with-deps
```

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROMA_WEB_TOKEN` | **必填** | WS 认证 token，未设置拒绝启动 |
| `PROMA_WEB_HOST` | `127.0.0.1` | 监听地址；局域网/NAS 用 `0.0.0.0` |
| `PROMA_WEB_PORT` | `6810` | 端口 |
| `PROMA_WEB_USER_DATA` | `~/.proma-web` | 数据目录（隔离）；NAS 部署指 `/vol1/@appdata/proma`（systemd 用绝对路径，`~` 不展开） |
| `PROMA_WEB_SAFE_KEY` | 自动生成持久化 | safeStorage 加密密钥（`<userData>/.safe-key`） |
| `PROMA_WEB_VERBOSE_ERRORS` | 关 | `1` 时错误响应含堆栈与 handler 内部 message（仅调试）；默认脱敏为 `invoke failed (trace: xxx)` |
| `PROMA_WEB_MAX_MSG_BYTES` | `4194304` | 单条 WS 消息上限 |
| `PROMA_WEB_MAX_RESULT_BYTES` | `16777216` | 出站 result 上限 |
| `PROMA_WEB_MAX_ARGS_DEPTH` | `20` | invoke args 最大递归深度 |
| `PROMA_WEB_INVOKE_TIMEOUT_MS` | `120000` | invoke 超时 |
| `PROMA_WEB_RATE_LIMIT` | `600` | 每连接 60s 窗口 invoke 上限 |
| `PROMA_WEB_CONN_RATE_LIMIT` | `10` | 同 IP 10s 窗口新连接上限（防快速重连 DoS） |
| `PROMA_WEB_ALLOWED_ORIGINS` | 同源 | 逗号分隔 Origin 白名单（如 `http://<server-ip>:6810`）；默认仅允许同源（Origin host === Host） |
| `PROMA_WEB_LOG_LEVEL` | `info` | debug/info/warn/error |
| `PROMA_SRC` | `<proma-src>` | Proma 源码路径 |

## WS 协议（v1）

两类通道：
- **request**：客户端 `{type:'invoke', id, channel, args}` → 服务端 `{type:'result', id, ok, result|error}`
- **event**：服务端 `{type:'event', channel, payload}` → 客户端按 channel 分发（映射 `on/once` 订阅）

其余帧：`ready`（握手，含 protocol + channels）/ `ping`/`pong`（心跳）/ `error`（协议级）/
`bye`（服务端主动断开，如被新连接顶替）。

安全：握手 `?token=` 校验；单活跃连接互斥（新连接顶替旧连接）；消息大小限制；速率限制（invoke + 连接频率）；
错误响应脱敏（`PROMA_WEB_VERBOSE_ERRORS=1` 才含堆栈）；Origin 校验（#28，默认同源，`PROMA_WEB_ALLOWED_ORIGINS` 白名单）。

> ⚠️ 安全提示（M9 缓解）：token 通过 URL query 传递（`ws://host:6810/ws?token=...`）。阶段 3 已缓解：
> 页面 token-gate 把 `?token=` 立即转存 `localStorage` 并清除 URL 参数，避免留在浏览器历史/Referer。
> 仍建议强 token + 不暴露公网；cookie/session 化留阶段 4。

## 测试

- `verify.sh`：HTTP 层（401/静态/注入/health/metrics）+ WS 层（握手/invoke/未知通道/真实事件）+
  `--extra`（互斥/大消息/bridge 心跳/extended）+ 浏览器冒烟（headless chromium）
- `client-test.ts`：协议层测试客户端（基础 + `--extra` 含 #11 真实事件断言）
- `web/bridge-test.ts`：浏览器桥运行态（连接/invoke/sendSync 乐观/真实事件/心跳保活）
- `browser-smoke.ts`：headless chromium 全链路（window.electronAPI 注入 → invoke runtime:get-status）
- 重新生成 preload.ts：`PROMA_SRC=<proma-src> bun run web/build-web-preload.ts`
- 重新打包 web-preload.js：`PROMA_SRC=<proma-src> bun run web/build-preload-bundle.ts`
- 重新构建 renderer：`cd <proma-src>/apps/electron && bun run build:renderer`（产物由 verify.sh 自动同步到 public/）

## 部署衔接

- systemd：`deploy/proma-web.service`（NAS/systemd 环境）
- fpk：阶段 5 打包，数据目录 `/vol1/@appdata/proma`，见 `docs/飞牛OS-应用打包SOP.md`
- 端口：6810（Proma Web）；已占用 6789/6790/6768/5122

## 注意事项

- **许可证**：Proma AGPL-3.0，个人自用 OK，不商用不分发
- **上游升级**：web 桥作为 fork 维护，升级时 `patch-proma.sh undo` → 拉新代码 → `apply`；
  preload.ts / web-preload.js 用 `build-web-preload.ts` / `build-preload-bundle.ts` 重新生成
- **node_modules/electron**：已还原为原始文件（阶段 2 不再物理替换），靠源码级 patch
- **已知限制**：`node:sqlite` 在 Bun 1.3.14 缺失（planning 提醒检查降级跳过）；
  全局快捷键/托盘/系统通知在 Web 模式不可用（stub 降级）
- **浏览器冒烟依赖**：`bun add playwright` + `bunx playwright install chromium --with-deps`（一次性，走代理）

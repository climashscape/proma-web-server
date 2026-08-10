# Proma Web 界面测试指南

> 阶段 3 renderer web 化完成后的验收测试清单。环境：WSL server（token 见启动命令）；浏览器 http://127.0.0.1:6810/?token=xxx

## 启动

```bash
# WSL
cd /opt/proma-web-server
PROMA_WEB_TOKEN=<your-token> PROMA_WEB_TEST_MODE=1 bun run server.ts
# 浏览器打开 http://127.0.0.1:6810/?token=<your-token>
# URL token 自动转存 localStorage 并清除参数；无 token 显示登录遮罩
```

## 前置：配 API key

设置 → 渠道 → DeepSeek → 填真实 API Key → 保存。（预设为空 key 重建过，不配对话会 401）

## P0 必测

| # | 模块 | 步骤 | 预期 |
|---|---|---|---|
| 1 | 页面加载 | 打开首页 | 侧边栏 + 会话列表 + 输入框渲染；URL 自动去掉 `?token=`；Console 除 planning node:sqlite 已知降级外不应有红色错误 |
| 2 | Agent 对话 | 新建会话 → 粘贴下方测试提示词 → 发送 | 流式逐字输出正常 |
| 3 | 会话管理 | 新建/切换/重命名/删除会话 | 列表刷新正常 |
| 4 | 工作区 | 打开工作区选择器 | 可见 default 工作区（~/.proma-dev/agent-workspaces） |
| 5 | 主题 | 深色/浅色/系统切换 | 不闪烁、CSS 正确 |
| 6 | 渠道保存 | 填 key 保存 | 保存成功、页面上更新可见 |

### Agent 对话测试提示词（可粘贴）

```
你现在运行在 Web 模式（通过浏览器+WebSocket 访问 Proma 桌面应用的 server 层，而非原生 Electron）。请用一句话分别回答以下三条：
1. 你能否正常接收我的消息？（用于验证事件流端到端）
2. 你当前的工作目录是什么？
3. 你当前有哪些可用工具？
不需要调用任何工具，直接回答即可。
```

验证：消息接收（事件流）、环境感知（cwd/workspace）、工具列表暴露（MCP/Skills）。

## 已知降级（验证不崩即可，不修复）

| # | 模块 | 预期行为 |
|---|---|---|
| 7 | 规划面板（Todo/日程） | 加载失败提示（`node:sqlite` Bun 1.3.14 缺失），但页面不崩、其他面板不受影响 |
| 8 | 全局快捷键/系统通知/托盘 | Web 模式 stub 降级，功能不存在但不报错弹窗 |

## P1 边缘场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| 9 | 断线重连 | `kill $(cat /tmp/proma-web.pid)` 停 server → 浏览器显示断开 → 重启 server | bridge 自动重连、invoke 恢复 |
| 10 | beforeunload 同步保存 | 草稿里输入 → 直接关 tab → 重开 | 设置/草稿保留（sendSync 乐观路径） |
| 11 | 多 tab 互斥 | 同浏览器开第二个 tab 连同一 server | 第一个被顶替并提示「superseded」 |

## 反馈机制

测出问题 → 告诉我现象/截图 → 我看 `tail /tmp/proma-web-srv.log` + 改 Windows 侧源（`workspace-files/server-test/`）→ `verify.sh --extra` 回归。

## 长期维护

- **上游升级**：`patch-proma.sh undo` → 拉新 commit → `apply` → `build-web-preload.ts` 重新生成 → `build-preload-bundle.ts` 重新打包 → `bun run build:renderer` → `verify.sh --extra`
- **新增 invoke 通道**：preload.ts 重新生成后新方法自动出现在 `window.electronAPI`（机械映射）
- **server/stub/bridge 改动**：都要跑 `verify.sh --extra` 全量回归
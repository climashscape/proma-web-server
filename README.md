# Proma Web Server（Linux 服务器版）

把 [Proma](https://github.com/proma-ai/Proma) 桌面 Agent 通过 Bun 单进程服务化，
在 Linux 服务器/NAS 上用浏览器访问完整的 Agent 能力。

## 架构
```
浏览器 (http://<ip>:6811)
    │  nginx 反代（★Host $http_host）
    ▼
Bun server (127.0.0.1:6810)
    ├── HTTP 静态 UI（public/）
    └── WebSocket IPC 桥（/ws）
            │
            ▼
    Proma main handlers（复用不改，patch electron import）
```

> 端口口径：Bun server 默认监听 `127.0.0.1:6810`（PROMA_WEB_PORT 可改）；`6811` 是
> nginx 反代示例中的对外端口（见 deploy/nginx-proma-web.conf.example）。局域网/公网访问
> 必须经反代并建议配置 HTTPS（token 走 WS URL query，明文 HTTP 下会被中间人窃听）。

## 特性
- 对话 / Agent 会话（流式输出）
- 文件附加（浏览器原生选择器，base64；文件夹受浏览器沙箱限制暂不支持；单文件 base64 上限约 3MB）
- 渠道管理（DeepSeek / OpenCode Go 等，AES-256-GCM 加密存储）
- 任务 / 日程 / 自动化 / 子 Agent 协作
- 剪贴板（浏览器 navigator.clipboard，非 secure context 自动降级 execCommand）
- 主题切换

## 快速部署
```bash
# 推荐 clone 到 755 可读路径（服务用户需要读取仓库；不要放 /root 下）
git clone https://github.com/Aij2022/proma-web-server.git /opt/proma-web
cd /opt/proma-web
sudo bash deploy/install.sh
```

## 手动部署（核心步骤）
1. 安装 bun
2. `git clone https://github.com/proma-ai/Proma.git` 并 checkout main
3. `cd Proma && bun install`（必须先装依赖，且必须在 patch 之前）
4. `PROMA_SRC=<proma-path> bash patches/patch-proma.sh apply`（patch electron import + node:sqlite）
5. `cd server && bun install && PROMA_SRC=<proma-path> bun run build:web-preload`
6. 配置 `server/.env`（模板见 server/.env.example：PROMA_WEB_TOKEN / PROMA_SRC / PROMA_WEB_PORT 等，
   完整变量清单含 MAX_MSG_BYTES / TRUST_PROXY / USER_DATA / SAFE_KEY；写入后 `chmod 600`）
7. 配置渠道（<userData>/.proma-web/channels.json + settings.json 的 agentChannelId/agentModelId，
   注意与桌面版 ~/.proma 隔离，apiKey 跨环境不迁移）
8. 启动 `bun run server.ts`，nginx 反代见 deploy 示例

## 测试
```bash
cd tests
bash verify.sh --extra    # ⚠️ 跑完会杀 server，测试后需重启（含 handler-coverage 70+ 通道覆盖）
```

## 已知限制
- 文件夹选择：浏览器沙箱无法获取磁盘绝对路径，Web 版暂不支持（有提示）
- 文件附加：单文件上限约 3MB（base64 后受服务端 4MB 消息上限约束，可用 PROMA_WEB_MAX_MSG_BYTES 调整）
- shell.openExternal / showItemInFolder：stub（已知降级）
- 系统通知 / Dock / 全局快捷键：Web 不支持（Notification.isSupported 返回 false，renderer 不会走"已通知"假成功）
- ipcMain.on/once 通知通道：Web 模式不路由（上游调用方均为 Electron 特有场景：beforeunload 同步保存、语音听写）
- 多标签页：单活跃连接互斥，同时打开多个标签页会互顶；连续被顶 2 次后停止自动重连，需手动刷新
- 版本号：上报给 renderer 的版本默认读 PROMA_SRC/package.json（可用 PROMA_WEB_PROMA_VERSION 覆盖）

## 安全说明
- **token 明文存于浏览器 localStorage**：同源 XSS 或共享电脑可窃取，勿在公共电脑使用；服务端换 token 后旧会话需重新输入
- **WS 握手 URL 带 token**（`/ws?token=...`）：nginx 默认 access log 会记录完整 query——务必使用 deploy 示例中的脱敏 log_format（不含 query 与 Referer）或配 HTTPS
- 局域网明文 HTTP 下 token 可被中间人窃听，公网部署必须 HTTPS 反代
- `PROMA_WEB_TRUST_PROXY=1` 仅限可信反代（nginx 显式 `proxy_set_header X-Forwarded-For $remote_addr`），否则客户端可伪造 IP 绕过限频

## 踩坑
- verify.sh 会杀 server：测试后需重启（PID 文件精确清理，不再宽匹配 pkill）
- nginx 反代必须用 `$http_host` 传递 Host（否则 Origin 同源校验失败）；`PROMA_WEB_TRUST_PROXY=1`
  可让限频按 X-Forwarded-For 取真实客户端 IP（仅限可信反代，否则可伪造）
- fnOS 双 nginx 场景：注意外层反代同样要透传 Host/Upgrade 头
- node:sqlite shim：Bun 1.3.14 无 node:sqlite，planning 模块由 bun:sqlite shim 替代（:name 命名参数自动转换）
- apiKey 跨环境不迁移：渠道密钥加密存储于 <userData>/.safe-key，换机/换数据目录需重新录入
- onboarding：首次访问用 `?token=` 打开会自动转存并清除 URL 参数；token 错误时页面会提示重新输入
- 重复运行 install.sh 是幂等的（复用已有 .env 的 token），不会轮换 token 踢掉已认证会话

## 免责声明
非官方项目，基于 [proma-ai/Proma](https://github.com/proma-ai/Proma) 的 Web 服务化实验，
遵循 AGPL-3.0（上游 LICENSE）。与 Proma 官方无关。

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

## 特性
- 对话 / Agent 会话（流式输出）
- 文件附加（浏览器原生选择器，base64；文件夹受浏览器沙箱限制暂不支持）
- 渠道管理（DeepSeek / OpenCode Go 等，AES-256-GCM 加密存储）
- 任务 / 日程 / 自动化 / 子 Agent 协作
- 剪贴板（浏览器 navigator.clipboard）
- 主题切换

## 快速部署
```bash
git clone https://github.com/aij2022/proma-web-server.git
cd proma-web-server
sudo bash deploy/install.sh
```

## 手动部署（核心步骤）
1. 安装 bun
2. `git clone https://github.com/proma-ai/Proma.git` 并 checkout main
3. `cd Proma && bun install`（必须先装依赖，且必须在 patch 之前）
4. `PROMA_SRC=<proma-path> bash patches/patch-proma.sh apply`（patch electron import + node:sqlite）
5. `cd server && bun install && PROMA_SRC=<proma-path> bun run build:web-preload`
6. 配置 `.env`（PROMA_WEB_TOKEN / PROMA_SRC / PROMA_WEB_PORT）
7. 配置渠道（.proma-dev/channels.json + settings.json 的 agentChannelId/agentModelId）
8. 启动 `bun run server.ts`，nginx 反代见 deploy 示例

## 测试
```bash
cd tests
bash verify.sh --extra    # ⚠️ 跑完会杀 server，测试后需重启
```

## 已知限制
- 文件夹选择：浏览器沙箱无法获取磁盘绝对路径，Web 版暂不支持（有提示）
- shell.openExternal / showItemInFolder：stub（已知降级）
- 系统通知 / Dock / 全局快捷键：Web 不支持（已 stub）

## 踩坑
见本仓库 docs 或下方列表：verify.sh 杀 server / nginx $http_host / fnOS 双 nginx / node:sqlite shim / apiKey 跨环境不迁移 / onboarding

## 免责声明
非官方项目，基于 [proma-ai/Proma](https://github.com/proma-ai/Proma) 的 Web 服务化实验，
遵循 AGPL-3.0（上游 LICENSE）。与 Proma 官方无关。

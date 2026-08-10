# Proma Web · 全功能测试计划（完整周密）

> 版本 2026-08-10 · server PID 4073 · token `<your-token>`
> 访问入口：http://127.0.0.1:6810/?token=<your-token>
> Web 版工作区：`/root/.proma-dev/agent-workspaces/default`
> 桌面版工作区：`workspace-files`（本机）

---

## 一、准备

| 步骤 | Web 版 | 桌面版 |
|---|---|---|
| 启动 | WSL `bun run server.ts`，token=<your-token> | 桌面已启动，或直接开始 |
| 验证存活 | `curl -s http://127.0.0.1:6810/health` → `status:ok` | 不适用 |
| 浏览器 | http://127.0.0.1:6810/?token=<your-token> | 桌面原生窗口 |
| API 密钥 | 设置→渠道→DeepSeek 填 key | 同 |
| 调试台 | F12 Console，错误应清零（仅 AudioContext warn 允许） | 同 |
| 可用数据 | 已有 1 个工作区 default、1 渠道 DeepSeek | 读取本地数据（可能更丰富） |

## 二、自动验证（我这边跑）

在开发端补位，不打扰你：

```
# 高速回归（2 分钟）
bash /opt/proma-web-server/verify.sh --extra
# Agent 事件流 E2E（有 key 时验证真实 chunk）
PROMA_WEB_TOKEN=<your-token> bun run /opt/proma-web-server/e2e-agent-stream.ts
# 系统覆盖统计：
#  - HTTP 层：401/静态/注入/health/metrics
#  - WS 层：invoke 真实 handler / 未知通道 / 真实事件 / 互斥 / 大消息 / 心跳
#  - P1 扩展：非法帧/深 args/大 result/重复 id/脱敏/连接限频
#  - bridge：连接/invoke/sendSync/事件分发/心跳 32s
#  - key-handlers：8 通道只读冒烟（全量 320 通道覆盖留改进）
#  - 浏览器冒烟：electronAPI 注入/token 转存/getRuntimeStatus
```

## 三、两套自测提示词

### A. 给 Web 版 Proma（浏览器的那个 Agent）

**粘贴到 Web 版 Proma 对话输入框，发送：**

```
你现在运行在 Proma Web 模式（浏览器+WS 桥）。请对宿主（你自身所在的 Web 版 Proma）做以下全面自检。**每项必须用到真实工具调用，不能只靠推测。** 全部完成后在最后给一个汇总表（✅/❌）。

# 检查清单

## 1. 基础环境
- 调用运行时状态获取：runtime:get-status 检查 node/bun/git 字段
- 列出当前工作区：列出 workspace-files 根目录（ls）
- 读取 .proma 数据目录：读取 /root/.proma-dev 下的关键 JSON 文件（如 channels.json），确认已配置渠道
- 检查是否存在 .context 子目录，确认内部文件数

## 2. Agent 核心
- 新建一个 Agent 会话（再创建新 session），向自己发送 "只回复单词 hello，不用工具" 并等待回复 —— 验证流式 chunk 事件端到端
- 用 web_search 搜索 "Proma AI agent"，取前 3 条结果摘要 —— 验证 Tavily MCP
- 列出当前工作区的 skill 列表，打印名称（列出目录 skills/ 下的 SKILL.md 文件名）
- 用 read 工具读取 /root/.proma-dev/agent-workspaces/default/workspace-files/ 下任意文件（若无则先 write 写入 "test file content" 到 /root/.proma-dev/agent-workspaces/default/workspace-files/test.txt，再读取并删除）
- 用 write 工具写入 /root/.proma-dev/agent-workspaces/default/workspace-files/test-math.md，写入 100 字数学测试内容，再用 grep 搜索 "数学" 确认存在，最后用 edit 工具替换 "数学" 为 "math"，再确认替换生效。最后删除该文件
- 用 bash 执行 "echo prom-web-test && date" 验证 bash 工具

## 3. 任务与规划
- 用 TaskCreate 创建 3 个检查任务（主题：规划检查/文件检查/代理检查），逐一更新为 completed 状态
- 用 list_todos 列出 Todo（应返回数组或空）
- 用 create_todo 创建一个 Todo："Web 冒烟测试-Todo 测试"，priority=high，然后 list_todos 确认出现，最后删除
- 用 list_calendar_events 列出日程
- 用 list_groups 列出 Todo 分组和日程分组

## 4. 自动化与协作
- 用 list_automations 查看已有定时任务（可能为空）
- 用 list_available_agent_models 查看可用模型列表
- 用 delegate_agent 创建一个子 Agent（title:"自检子Agent"，role:custom，task:"回复单词 OK"），等待结果

## 5. 文件工具（Proma 工作台）
- cd 到 /root/.proma-dev/agent-workspaces/default/workspace-files
- write "hello world" 到 junk.txt，read 确认内容，rm 删除
- 确认 bash 工作目录落在 workspace-files 下（pwd 打印路径）

## 6. 设置/渠道
- 列出 channel:list
- 读取 /root/.proma-dev/agent-sessions.json 看会话持久化

最后给出汇总表（每项 ✅/❌ + 备注），然后附上一句结论："Web 版自检完成，N 项通过 / M 项需要关注，建议人工复查的功能模块：..."
```

### B. 给桌面版 Proma（当前和开发辅助）

桌面版或本 Agent 检查 Web 版宿主的存活状态：

```
# 桌面版/开发辅助：验证 Web 版 server 存活与业务状态

1. 用 curl 或 http fetch 访问 http://127.0.0.1:6810/health → 检查 status ok && uptime > 0
2. 访问 /metrics 检查 invokesTotal > 0（说明 WS 有实际流量）
3. 用 curl 访问 http://127.0.0.1:6810/ 确认 HTML 响应码 200
4. 检查 WSL 侧 server 日志 tail /tmp/proma-web-srv.log 看最近错误（Invokewarn 里不应有除了 traceId 以外的异常）
5. 检查 WSL 进程 pgrep -f "bun run server.ts" 存在
```

---

## 四、人工测试清单（你在浏览器操作）

**标记**：
- 🟢 两版均能测（核心）
- 🔵 Web 版重点关注（已发现过 bug 的区域）
- ⚪ 桌面专用（不适用 Web）
- ⚠️ Web 已知降级（只需不崩）

### 4.1 会话与对话

| # | 操作 | 验证点 |
|---|---|---|
| 🔵 1 | 打开 Web 版页面，URL 自动清除 `?token=` | token-gate 转存正常；无登录遮罩 |
| 2 | 新建会话，发 "你好" | 流式逐字输出；完成后标题自动生成（如"你好"） |
| 3 | 发送 `请列出你的可用工具，一行一个` | 返回工具列表（含 read/write/edit/grep/find/ls/bash/web_search/...） |
| 4 | 复制回复文字 → 粘贴到记事本验证 | 剪贴板写入成功 |
| 5 | 切换左侧会话列表，点历史会话 | 消息加载，可继续对话 |
| 6 | 重命名会话 | 名称保存，列表刷新 |
| 7 | 删除会话 | 列表消失 |
| 8 | 关掉标签页再重开（同 token） | 历史会话存在 |
| 🟢 9 | 模型切换（下拉选择 deepseek-v4-flash / deepseek-v4-pro） | 切换后发送应使用新模型 |
| 🔵 10 | 发送含 @ 文件引用（需先有 test.txt） | 文件引用编码并附带内容（有可能 /root/... 或相对路径） |

### 4.2 渠道设置

| # | 操作 | 验证点 |
|---|---|---|
| 🔵 1 | 打开设置→渠道→DeepSeek，点「获取模型列表」 | 列表拉取成功或给出合理错误 |
| 🔵 2 | 点「测试请求」 | 成功或给出明确错误消息（不应只显示通用失败而不给原因） |
| 🔵 3 | 修改 baseURL → 保存 | 保存成功（不再报"渠道创建失败"） |
| 🔵 4 | 新建第二条渠道（随意填无 key 也行）→ 删除 | 创建+删除链路通 |
| 🔵 5 | 检查 apiKey 保存后再次打开是否仍显示掩码 | 密文不丢失（加解密 roundtrip） |

### 4.3 规划（🔵 重点）

| # | 操作 | 验证点 |
|---|---|---|
| 1 | 打开任务/日程面板（快捷方式或侧栏） | 面板渲染，不报 serve error |
| 2 | 创建 Todo "测试 Todo"，priority=高 | 列表出现且带优先级颜色 |
| 3 | 更新 Todo 标题为 "测试 Todo 已改" | 列表更新 |
| 4 | 完成 Todo | 状态变为完成/划掉 |
| 5 | 创建日程 "测试日程"，全天 | 日历区域可见 |
| 6 | 创建分组 "TestGroup"（todo 分组） | 创建后可在 Todo 归属中选中 |
| 7 | 创建标签 "urgent" | 标签列表出现 |
| 8 | 给 Todo 绑定标签 | 标签显示 |
| 9 | 回到 Agent 对话让 Agent 用工具列出 Todo（发送"list_todos"） | 返回刚创建的 Todo（跨通道验证） |
| 10 | 删除所有测试数据 | 清理干净 |

### 4.4 自动化与任务

| # | 操作 | 验证点 |
|---|---|---|
| 🔵 1 | 对话中输入 "列出当前的定时任务" | automation:list 返回数组（可空） |
| 🔵 2 | 让 Agent 创建一个定时任务（如 "每 24h 写一份 web 健康报告，存到 /tmp/health-report.txt"） | Agent 完成调用 automation:create，并返回确认 |
| 🔵 3 | 对话中说 "删除刚才的定时任务" | automation:delete 成功 |
| 🔵 4 | 对话中说 "创建 3 个 Todo：A/B/C" 并让其用 TaskCreate 管理 | 进度条出现，3 个子任务更新完成 |
| 🔵 5 | 让 Agent deploy 一个子 Agent 协作研究 "列出当前项目结构" | 子 Agent 完成并返回结果 |

### 4.5 工作区

| # | 操作 | 验证点 |
|---|---|---|
| 🟢 1 | 切换工作区（目前只有一个 default） | 没有崩溃/报错 |
| 🔵 2 | 让 Agent 在当前工作区新建文件 readme-test.md，写入 "hello workspace" | 文件确实生成在 /root/.proma-dev/agent-workspaces/default/workspace-files/ |
| 🔵 3 | 用 find 工具搜索 *readme* | 找到 readme-test.md |
| 🔵 4 | 删除 readme-test.md | 清理 |

### 4.6 文件 / MCP / Skill

| # | 操作 | 验证点 |
|---|---|---|
| 🔵 1 | 对话中说 "显示当前环境 mcp 配置" | 回显 mcp.json 内容或列出 MCP 列表 |
| 🔵 2 | 对话中说 "list_available_agent_models" | 返回模型列表 |
| 🔵 3 | 让 Agent 用 read 工具读取 AGENTS.md | 如不存在说明是新工作区，正常 |
| 🔵 4 | 对话中用 tavily web_search 搜 "news 2026" | 返回搜索结果 |

### 4.7 主题与 UI

| # | 操作 | 验证点 |
|---|---|---|
| 🔵 1 | 深/浅/系统主题切换 | 不闪烁，CSS 正常 |
| 🔵 2 | 特殊风格（如有） | 效果应用 |
| 🔵 3 | 通知设置 open/close | 有 audio 提示（可能浏览器限制点击后才有声音） |
| ⚠️ 4 | Copy 按钮 | 已验证通过 |
| ⚠️ 5 | 新会话/切换/废弃 | 不 buggy |

### 4.8 已知降级（只确认不崩溃）

| # | 模块 | 说明 |
|---|---|---|
| ⚪ | dock-badge | Web 无 Dock，不报错（已修 stub） |
| ⚪ | agent-island | macOS 专属，不报错（已修 no-op handler） |
| ⚪ | 全局快捷键 | Web 不支持 |
| ⚠️ | 系统通知 | 弹窗可能受限；不崩溃即可 |
| ⚠️ | AudioContext | 浏览器限制自动播放；不报 JS 错误即可 |

### 4.9 文档/技能类（条件性）

| # | 触发 | 验证点 |
|---|---|---|
| 🔵 1 | 对话说 "生成一份 3 页 pptx：标题测试，第一页 hello slide" | 提醒寻找 pptx skill |
| 🔵 2 | 对话说 "生成一份 docx 文件：内容=测试文档" | 提醒寻找 docx skill → 生成并下载 |

---

## 五、跨版本对照（桌面 vs Web）

| 功能 | 桌面版 | Web 版 |
|---|---|---|
| 启动风格 | Electron 原生窗口 | 浏览器标签 |
| API 接入 | 同 key | 同 key（渠道数据在 WSL ~/.proma-dev/channels.json） |
| 上游模型 | 一致 | 一致 |
| 通知 | 系统通知+声音 | Web notification 弹窗或降级 |
| Dock/Tray | 有 | 无（已 stub） |
| 快捷键 | 支持全局 | 不支持（stub） |
| 工作区数据 | ~/.proma | ~/.proma-dev（隔离） |

**验证结论**：你可以在两版同时对话同一个 key，验证回复一致。其他差异在已知降级表里。

---

## 六、快速指令卡片（可粘贴）

### 启动回归
```
cd /opt/proma-web-server
bash verify.sh --extra
```

### 停止 server
```
kill $(cat /tmp/proma-web.pid)
pkill -f 'bun run server.ts$'
```

### 启动 server
```
cd /opt/proma-web-server
PROMA_WEB_TOKEN=<your-token> PROMA_WEB_TEST_MODE=1 nohup bun run server.ts > /tmp/proma-web-srv.log 2>&1 & echo $! > /tmp/proma-web.pid
```

### 日志检查
```
tail -f /tmp/proma-web-srv.log
```

---

## 七、回归检查清单（维护方 / 我执行）

- [ ] verify.sh --extra（全 15/15）
- [ ] e2e-agent-stream.ts（有 key 时跑）
- [ ] console-audit.ts（前端错误应为零）
- [ ] supersede-test.ts（被顶替后重连恢复）
- [ ] 文档更新：handoff.md / phase2-review 跟踪表
- [ ] WSL 端最新同步（Windows 侧源 -> WSL）

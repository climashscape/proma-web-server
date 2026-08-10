#!/bin/bash
# verify.sh — Proma Web Server 回归验证（仓库布局版）
#
# 流程：清理旧进程 → 检查/应用 patch → 构建 web-preload bundle（如缺失）
#      → 随机 token 启动 server → HTTP 层验证（401/静态/注入/health/metrics）
#      → WS 层验证（握手/invoke/未知通道/互斥/大消息/心跳/真实事件）→ 浏览器冒烟（headless chromium）
#
# 用法（在仓库 tests/ 目录下执行）:
#   bash verify.sh            （快速：基础 + HTTP + WS + 浏览器冒烟）
#   bash verify.sh --extra    （全量：+ 互斥 + 大消息 + bridge + extended）
#
# 环境变量:
#   PROMA_SRC   Proma 源码目录（patch 后；默认取当前目录上两级 ../Proma 或 /opt/Proma）
#   PROMA_WEB_PORT  测试端口（默认 6810）
set -u

EXTRA=0
[ "${1:-}" = "--extra" ] && EXTRA=1

# ---- 仓库布局定位（tests/verify.sh → repo root）----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
PATCHES_DIR="$REPO_ROOT/patches"

# ---- 默认值 ----
PORT="${PROMA_WEB_PORT:-6810}"
PID_FILE=/tmp/proma-web.pid
BASE="http://127.0.0.1:${PORT}"
# PROMA_SRC 探测：环境变量 > ../Proma（仓库旁目录）> /opt/Proma
if [ -z "${PROMA_SRC:-}" ]; then
  if [ -d "$REPO_ROOT/../Proma/apps/electron" ]; then
    PROMA_SRC="$(cd "$REPO_ROOT/../Proma" && pwd)"
  elif [ -d "/opt/Proma/apps/electron" ]; then
    PROMA_SRC="/opt/Proma"
  else
    echo "❌ 未找到 Proma 源码：请设置 PROMA_SRC 环境变量（例如 PROMA_SRC=/opt/Proma）"
    exit 1
  fi
fi
RENDERER_DIST="$PROMA_SRC/apps/electron/dist/renderer"

echo "=== 环境 ==="
echo "REPO_ROOT=$REPO_ROOT"
echo "PROMA_SRC=$PROMA_SRC"
echo "PORT=$PORT"

# 1) 清理可能残留的旧 server 进程（M6/#9：用 PID 文件精确清理，避免 pkill 误杀）
echo "=== [1/8] 清理旧进程 + 检查 patch 状态 ==="
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 1
  kill -9 "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
# 兜底：匹配 bun run server.ts（cmdline 无完整路径）与绝对路径两种形态
pkill -f 'bun run server.ts$' 2>/dev/null || true
pkill -f 'server.ts$' 2>/dev/null || true
sleep 1

# 检查 Proma 源码级 electron stub patch：未 patch 时自动 apply
patch_status=$(PROMA_SRC="$PROMA_SRC" bash "$PATCHES_DIR/patch-proma.sh" status)
if echo "$patch_status" | grep -q '链接: 不存在'; then
  echo "  （未检测到 electron stub patch，自动 apply…）"
  PROMA_SRC="$PROMA_SRC" bash "$PATCHES_DIR/patch-proma.sh" apply
else
  echo "  （electron stub patch 已生效）"
fi

# 2) 构建 web-preload bundle（阶段 3；如 public/web-preload.js 已存在则跳过）
echo "=== [2/8] 构建 web-preload bundle ==="
if [ -f "$SERVER_DIR/public/web-preload.js" ]; then
  echo "  ✅ web-preload.js 已存在（跳过构建；如需重建删掉该文件后重跑）"
else
  if (cd "$SERVER_DIR" && PROMA_SRC="$PROMA_SRC" bun run build:web-preload); then
    echo "  ✅ web-preload bundle 构建完成"
  else
    echo "  ❌ web-preload bundle 构建失败（后续验证依赖该产物，终止）"
    exit 1
  fi
fi

# 3) 启动 server（随机 token，与 client 共用；#15：health 轮询替代固定 sleep）
export PROMA_WEB_TOKEN="${PROMA_WEB_TOKEN:-$(openssl rand -hex 16)}"
echo "=== [3/8] 启动 server（token=${PROMA_WEB_TOKEN:0:8}..., port=${PORT}）==="
(cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_TEST_MODE=1 PROMA_WEB_PORT="$PORT" PROMA_SRC="$PROMA_SRC" nohup bun run server.ts > /tmp/proma-web-srv.log 2>&1 & echo $! > "$PID_FILE")
for i in $(seq 1 30); do
  if curl -s -m 2 "${BASE}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "  （server 就绪，${i}s）"
    break
  fi
  sleep 1
done

# 4) HTTP 层验证
echo "=== [4/8] HTTP 层 ==="
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 $2 实际 $3)"; fail=$((fail+1)); fi
}

# 无 Upgrade 头请求 /ws → token 检查优先，期望 401（普通 HTTP 访问 /ws 需认证）
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "${BASE}/ws")
check "无 Upgrade 头 /ws → 401" "401" "$c"

# 错 token → 401
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "${BASE}/ws?token=wrong")
check "错 token → 401" "401" "$c"

# 无 token → 401
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "${BASE}/ws")
check "无 token → 401" "401" "$c"

# 静态页 → 200
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "${BASE}/")
check "静态页 → 200" "200" "$c"

# 阶段 3：index.html 含 web-preload 注入
body=$(curl -s -m 3 "${BASE}/")
echo "$body" | grep -q '/web-preload.js' && check "index.html 含 web-preload 注入" "1" "1" || check "index.html 含 web-preload 注入" "1" "0"
echo "$body" | grep -q 'proma-token-gate' && check "index.html 含 token-gate" "1" "1" || check "index.html 含 token-gate" "1" "0"

# 阶段 3：web-preload.js 可访问
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "${BASE}/web-preload.js")
check "web-preload.js → 200" "200" "$c"

# health → 200 且 status ok
h=$(curl -s -m 3 "${BASE}/health")
c=$(echo "$h" | grep -o '"status":"ok"' | head -1)
check "health status=ok" '"status":"ok"' "$c"
ch=$(echo "$h" | grep -o '"channels":[0-9]*' | head -1)
echo "  (health channels: $ch)"

# metrics → 200
c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "${BASE}/metrics")
check "metrics → 200" "200" "$c"

# 5) WS 层验证
echo "=== [5/8] WS 层 ==="
echo "  （invoke 真实 handler / 未知通道 / 事件订阅）"
if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_WS="ws://127.0.0.1:${PORT}/ws" bun run client-test.ts); then
  echo "  ✅ client-test 基础通过"; pass=$((pass+1))
else
  echo "  ❌ client-test 基础失败"; fail=$((fail+1))
fi

# 关键 handler 冒烟（M4）
if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_WS="ws://127.0.0.1:${PORT}/ws" bun run key-handlers-test.ts); then
  echo "  ✅ 关键 handler 冒烟通过"; pass=$((pass+1))
else
  echo "  ❌ 关键 handler 冒烟失败"; fail=$((fail+1))
fi

if [ "$EXTRA" = "1" ]; then
  if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_WS="ws://127.0.0.1:${PORT}/ws" bun run client-test.ts --extra); then
    echo "  ✅ client-test 扩展（互斥/大消息/真实事件）通过"; pass=$((pass+1))
  else
    echo "  ❌ client-test 扩展失败"; fail=$((fail+1))
  fi
  # bridge 运行态（浏览器桥，连真实 server；含 #10 真实事件断言，依赖 TEST_MODE）
  if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" bun run web/bridge-test.ts); then
    echo "  ✅ bridge 运行态通过"; pass=$((pass+1))
  else
    echo "  ❌ bridge 运行态失败"; fail=$((fail+1))
  fi
  # P1 扩展验证（非法帧/深 args/大 result/重复 id/脱敏/连接限频）
  if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_WS="ws://127.0.0.1:${PORT}/ws" bun run extended-test.ts); then
    echo "  ✅ extended-test（P1 验证）通过"; pass=$((pass+1))
  else
    echo "  ❌ extended-test（P1 验证）失败"; fail=$((fail+1))
  fi
fi

# 6) 浏览器冒烟（阶段 3：headless chromium 验证 window.electronAPI + invoke）
echo "=== [6/8] 浏览器冒烟 ==="
# 上一步 extended-test 的 #23 连接限频测试会耗尽 10s 窗口的连接配额，等窗口过期再跑浏览器
sleep 12
if [ -d "$SERVER_DIR/node_modules/playwright" ] || (cd "$SERVER_DIR" && bun pm ls 2>/dev/null | grep -q playwright); then
  if (cd "$SERVER_DIR" && PROMA_WEB_TOKEN="$PROMA_WEB_TOKEN" PROMA_WEB_PORT="$PORT" bun run browser-smoke.ts); then
    echo "  ✅ 浏览器冒烟通过"; pass=$((pass+1))
  else
    echo "  ❌ 浏览器冒烟失败"; fail=$((fail+1))
  fi
else
  echo "  ⚠️ playwright 未安装，跳过浏览器冒烟（首次：cd server && bun add playwright && bunx playwright install chromium --with-deps）"
fi

# 7) 收尾
echo "=== [7/8] 收尾 ==="
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
sleep 1
echo "===== 汇总: $pass 通过 / $fail 失败 ====="
[ "$fail" = "0" ] && exit 0 || exit 1

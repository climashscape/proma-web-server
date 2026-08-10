#!/bin/bash
# install.sh — Proma Web Server 一键部署（Ubuntu/Debian Linux 服务器）
# 用法: sudo bash install.sh
# 环境变量可覆盖：PROMA_SRC / PORT / PROMA_WEB_TOKEN / RUN_USER / DATA_DIR
set -euo pipefail

PROMA_SRC="${PROMA_SRC:-/opt/Proma}"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-6810}"
ENV_FILE="$WEB_DIR/server/.env"
# token 幂等：已部署过（.env 存在且含 token）则复用，避免重复部署轮换 token 踢掉所有已认证会话
if [ -z "${PROMA_WEB_TOKEN:-}" ] && [ -f "$ENV_FILE" ] && grep -q '^PROMA_WEB_TOKEN=.' "$ENV_FILE"; then
  TOKEN="$(grep '^PROMA_WEB_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
else
  TOKEN="${PROMA_WEB_TOKEN:-$(openssl rand -hex 32)}"
fi
RUN_USER="${RUN_USER:-proma}"
DATA_DIR="${DATA_DIR:-/var/lib/proma-web}"

BUN_BIN="$(command -v bun || true)"

echo "=== 1. 安装 bun（如缺失）==="
if [ -z "$BUN_BIN" ]; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  BUN_BIN="$(command -v bun)"
fi
"$BUN_BIN" --version
# ★ 关键：复制到 /usr/local/bin，否则 systemd User=proma 无法访问 /root/.bun（权限 0700）
install -m 0755 "$BUN_BIN" /usr/local/bin/bun
BUN_BIN=/usr/local/bin/bun

echo "=== 2. Clone Proma 官方源码 + 安装依赖 ==="
if [ ! -d "$PROMA_SRC/.git" ]; then
  git clone https://github.com/proma-ai/Proma.git "$PROMA_SRC"
fi
cd "$PROMA_SRC" && git checkout main
# ★ 必须先 bun install（装 @proma/shared 等 workspace 依赖），且必须在 patch 之前：
#   bun install 重建 node_modules 会清掉 patch 建的 electron-stub 软链接
"$BUN_BIN" install

echo "=== 3. 应用 electron stub patch（STUB_DIR 由脚本自动推导）==="
PROMA_SRC="$PROMA_SRC" bash "$WEB_DIR/patches/patch-proma.sh" apply

echo "=== 4. 安装 server 测试依赖 + 构建 web-preload（无条件构建：build-web-preload 有 4 处重写 fail-fast 校验，上游 preload 结构变化会显式报错）==="
cd "$WEB_DIR/server"
"$BUN_BIN" install
# 固定 BUILD_TS：产物 banner 可复现（避免 git 管理的部署目录每次构建后 status 脏）
PROMA_WEB_BUILD_TS="$(date +%Y%m%d)" PROMA_SRC="$PROMA_SRC" "$BUN_BIN" run build:web-preload

echo "=== 5. 写入 .env（增量更新：保留已有键，避免覆盖用户手动配置的 TRUST_PROXY 等变量）==="
# HOST 定义前置（步骤 5 写入 .env 与步骤 6 注入 unit 均使用）；幂等：环境变量未设时复用 .env 旧值
if [ -z "${PROMA_WEB_HOST:-}" ] && [ -f "$ENV_FILE" ] && grep -q '^PROMA_WEB_HOST=.' "$ENV_FILE"; then
  HOST="$(grep '^PROMA_WEB_HOST=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
else
  HOST="${PROMA_WEB_HOST:-0.0.0.0}"
fi
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
escape_sed() { # 转义 sed 替换串特殊字符（& | \）并剔除换行，防自定义 token 含特殊字符时写坏 .env
  printf '%s' "$1" | tr -d '\n\r' | sed 's/[&|\\]/\\&/g'
}
set_key() { # key value —— 已存在则原位更新（sed 替换串需转义），否则追加（写原始值，仅剔除换行防注入）
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$(escape_sed "$2")|" "$ENV_FILE"
  else
    printf '%s\n' "$1=$(printf '%s' "$2" | tr -d '\n\r')" >> "$ENV_FILE"
  fi
}
set_key PROMA_WEB_TOKEN "$TOKEN"
set_key PROMA_SRC "$PROMA_SRC"
set_key PROMA_WEB_PORT "$PORT"
# HOST 一并写入 .env 作单一配置源（systemd EnvironmentFile 优先于 Environment，避免双源默认值冲突）
set_key PROMA_WEB_HOST "$HOST"

echo "=== 6. 配置 systemd（sed 替换模板占位符后安装）==="
mkdir -p "$DATA_DIR"
id "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$RUN_USER"
# 最小权限：只授数据目录与 .env 写权限；仓库与 Proma 源码保持 root 所有（服务只读）
chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
chown "$RUN_USER":"$RUN_USER" "$ENV_FILE" 2>/dev/null || true
# 可达性预检：服务用户必须能读仓库（server.ts/public/node_modules）与 Proma 源码，
# 否则 systemd User=$RUN_USER 启动即失败（如仓库 clone 在 /root 下 0700）
read_as_user() { # 以服务用户身份 test -r（runuser 优先，无则 su 兜底）
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- test -r "$1" 2>/dev/null
  else
    su -s /bin/sh "$RUN_USER" -c "test -r \"$1\"" 2>/dev/null
  fi
}
if ! read_as_user "$WEB_DIR/server/server.ts"; then
  echo "⚠️ 服务用户 $RUN_USER 无法读取仓库 $WEB_DIR（目录权限受限，如 clone 在 /root 下）。"
  echo "   请将仓库放到 755 可读路径（推荐 /opt/proma-web）或执行：chmod o+rx $(dirname "$WEB_DIR") $WEB_DIR"
  exit 1
fi
if ! read_as_user "$PROMA_SRC/package.json"; then
  echo "⚠️ 服务用户 $RUN_USER 无法读取 Proma 源码 $PROMA_SRC（目录权限受限）。"
  echo "   请执行：chmod o+rx $(dirname "$PROMA_SRC") $PROMA_SRC"
  exit 1
fi
sed -e "s|__RUN_USER__|$RUN_USER|g" \
    -e "s|__RUN_GROUP__|$RUN_USER|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__PROMA_SRC__|$PROMA_SRC|g" \
    -e "s|Environment=PROMA_WEB_PORT=6810|Environment=PROMA_WEB_PORT=$PORT|g" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$WEB_DIR/server|g" \
    -e "s|ExecStart=/usr/local/bin/bun|ExecStart=$BUN_BIN|g" \
    "$WEB_DIR/deploy/proma-web.service" > /etc/systemd/system/proma-web.service
systemctl daemon-reload
systemctl enable --now proma-web

echo "=== 7. 提示 ==="
echo "直接访问:   http://<server-ip>:${PORT}/?token=${TOKEN:0:8}...（完整 token 见 $ENV_FILE，权限 600）"
echo "经 nginx:   见 deploy/nginx-proma-web.conf.example（默认 0.0.0.0 监听，请务必配 HTTPS 反代）"
echo "=== 完成 ==="

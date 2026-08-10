#!/bin/bash
# install.sh — Proma Web Server 一键部署（Ubuntu/Debian Linux 服务器）
# 用法: sudo bash install.sh
# 环境变量可覆盖：PROMA_SRC / PORT / PROMA_WEB_TOKEN / RUN_USER / DATA_DIR
set -euo pipefail

PROMA_SRC="${PROMA_SRC:-/opt/Proma}"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-6810}"
TOKEN="${PROMA_WEB_TOKEN:-$(openssl rand -hex 32)}"
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

echo "=== 4. 安装 server 测试依赖 + 构建 web-preload（产物已存在则跳过）==="
cd "$WEB_DIR/server"
"$BUN_BIN" install
if [ -f public/web-preload.js ]; then
  echo "  （public/web-preload.js 已存在，跳过构建；强制重建：rm public/web-preload.js 后重跑）"
else
  PROMA_SRC="$PROMA_SRC" "$BUN_BIN" run build:web-preload
fi

echo "=== 5. 写入 .env ==="
cat > "$WEB_DIR/server/.env" <<ENVEOF
PROMA_WEB_TOKEN=$TOKEN
PROMA_SRC=$PROMA_SRC
PROMA_WEB_PORT=$PORT
ENVEOF

echo "=== 6. 配置 systemd（sed 替换模板占位符后安装）==="
mkdir -p "$DATA_DIR"
id "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
# 授权服务用户读取仓库与 Proma 源码（只读即可）
chown -R "$RUN_USER":"$RUN_USER" "$WEB_DIR" 2>/dev/null || true
chown -R "$RUN_USER":"$RUN_USER" "$PROMA_SRC" 2>/dev/null || true
sed -e "s|__RUN_USER__|$RUN_USER|g" \
    -e "s|__RUN_GROUP__|$RUN_USER|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__CHANGE_ME_RANDOM_TOKEN__|$TOKEN|g" \
    -e "s|__PROMA_SRC__|$PROMA_SRC|g" \
    -e "s|Environment=PROMA_WEB_PORT=6810|Environment=PROMA_WEB_PORT=$PORT|g" \
    -e "s|WorkingDirectory=/opt/proma-web|WorkingDirectory=$WEB_DIR/server|g" \
    -e "s|ExecStart=/usr/local/bin/bun|ExecStart=$BUN_BIN|g" \
    "$WEB_DIR/deploy/proma-web.service" > /etc/systemd/system/proma-web.service
systemctl daemon-reload
systemctl enable --now proma-web

echo "=== 7. 提示 ==="
echo "直接访问:   http://<server-ip>:${PORT}/?token=${TOKEN}"
echo "经 nginx:   见 deploy/nginx-proma-web.conf.example"
echo "=== 完成 ==="

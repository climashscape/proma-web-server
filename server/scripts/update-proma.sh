#!/bin/bash
# update-proma.sh — NAS 端 Proma Web 自更新脚本
# 由 server.ts 的 nas-updater:apply handler 通过 child_process spawn 调用
#
# 环境变量：
#   PROMA_SRC     Proma 源码 git repo（默认 /vol1/@appdata/proma/Proma）
#   PKGVAR        数据目录（默认 /vol1/@appdata/proma）
#   APP_DEST      程序目录（默认 /vol1/@appcenter/proma）
#   TARGET_COMMIT 目标 commit（短 hash，来自 nas-updater:check）
#   HTTP_PROXY / HTTPS_PROXY  代理地址（git fetch 必需）
#
# 输出格式（server.ts stdout 解析）：
#   [STEP] <description>   — 当前阶段描述
#   [PROGRESS] <0-100>     — 进度百分比
#
# 安全：
#   - 只动数据目录源码仓库 + 程序目录 renderer 产物（assets/web-preload.js/index.html）
#   - 失败自动回滚（trap ERR + restore_backup，幂等防重入）
#   - 保留最近 3 份备份，超出自动清理
#   - 不自动重启——完成后由用户在 UI / fnOS 应用管理中手动重启
set -Euo pipefail

PROMA_SRC="${PROMA_SRC:-/vol1/@appdata/proma/Proma}"
PKGVAR="${PKGVAR:-/vol1/@appdata/proma}"
APP_DEST="${APP_DEST:-/vol1/@appcenter/proma}"
TARGET_COMMIT="${TARGET_COMMIT:?TARGET_COMMIT must be set}"
PROXY="${HTTP_PROXY:-http://192.168.66.2:7890}"
BUN="${APP_DEST}/bin/bun"
PATCH_SH="${APP_DEST}/patches/patch-proma.sh"
STUB_DIR="${APP_DEST}/server/server/packages/electron-stub"
PUBLIC_DIR="${APP_DEST}/server/public"
BACKUP_DIR="${PKGVAR}/.backup"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"
LOG="${PKGVAR}/update.log"
# patch-proma.sh 的默认备份目录是 REPO_ROOT/.patch-backup（即 ${APP_DEST}/.patch-backup）
PATCH_BACKUP="${APP_DEST}/.patch-backup"

log() { echo "$(date '+%F %T') $*" >> "${LOG}"; }
step() { echo "[STEP] $1"; log "$1"; }
progress() { echo "[PROGRESS] $1"; log "progress $1"; }

ROLLED_BACK=0
restore_backup() {
  [ "$ROLLED_BACK" = "1" ] && exit 1
  ROLLED_BACK=1
  trap - ERR
  log "=== 自动回滚 ==="
  echo "[STEP] 更新失败，正在回滚..."
  # 1. 恢复源码（git checkout 到旧 commit）
  if [ -f "${BACKUP_PATH}/commit.txt" ]; then
    local old_commit
    old_commit="$(cat "${BACKUP_PATH}/commit.txt")"
    cd "${PROMA_SRC}"
    git config core.filemode false 2>/dev/null || true
    git checkout . 2>/dev/null || true
    git clean -fd -e node_modules -e .env -e .safe-key -e .patch-backup 2>/dev/null || true
    git checkout "${old_commit}" 2>/dev/null || log "回滚 checkout 失败（commit=${old_commit}）"
    rm -f "${PROMA_SRC}/.patch-applied"
    # 用更新前快照的 patch 备份覆盖（保证与备份时一致）
    if [ -d "${BACKUP_PATH}/patch-backup" ]; then
      cp -a "${BACKUP_PATH}/patch-backup/." "${PROMA_SRC}/" 2>/dev/null || true
    fi
    log "已 checkout 回 ${old_commit}"
  fi
  # 2. 恢复 assets（原子交换，尽力而为）
  if [ -d "${BACKUP_PATH}/assets" ]; then
    rm -rf "${PUBLIC_DIR}/assets.new" "${PUBLIC_DIR}/assets.old"
    [ -d "${PUBLIC_DIR}/assets" ] && mv "${PUBLIC_DIR}/assets" "${PUBLIC_DIR}/assets.old" 2>/dev/null || true
    cp -a "${BACKUP_PATH}/assets" "${PUBLIC_DIR}/assets" 2>/dev/null || log "恢复 assets 失败"
    rm -rf "${PUBLIC_DIR}/assets.old" 2>/dev/null || true
    log "已恢复 assets"
  fi
  # 3. 恢复 web-preload.js / index.html
  if [ -f "${BACKUP_PATH}/web-preload.js" ]; then
    cp "${BACKUP_PATH}/web-preload.js" "${PUBLIC_DIR}/web-preload.js" 2>/dev/null || log "恢复 web-preload.js 失败"
    log "已恢复 web-preload.js"
  fi
  if [ -f "${BACKUP_PATH}/index.html" ]; then
    cp "${BACKUP_PATH}/index.html" "${PUBLIC_DIR}/index.html" 2>/dev/null || true
  fi
  # 4. 重新 apply patch（旧代码）
  rm -f "${PROMA_SRC}/.patch-applied"
  if [ -f "${PATCH_SH}" ]; then
    PROMA_SRC="${PROMA_SRC}" STUB_DIR="${STUB_DIR}" bash "${PATCH_SH}" apply >> "${LOG}" 2>&1 || log "回滚 patch apply 失败"
    touch "${PROMA_SRC}/.patch-applied" 2>/dev/null || true
  fi
  # 5. 标记
  touch "${BACKUP_DIR}/.rollback-done"
  log "=== 回滚完成 ==="
  echo "[STEP] 已自动回滚，请检查日志 ${LOG}"
  exit 1
}

log "=== 自更新开始 (target: ${TARGET_COMMIT}) ==="
echo "[STEP] 自更新开始 (target: ${TARGET_COMMIT})"

# ==================== 1. 备份当前版本 ====================
step "备份当前版本"
mkdir -p "${BACKUP_PATH}"
cd "${PROMA_SRC}"
tar czf "${BACKUP_PATH}/Proma-src.tar.gz" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.patch-backup' \
  . 2>/dev/null || { log "备份失败"; exit 1; }
# 记录当前 commit
git rev-parse HEAD > "${BACKUP_PATH}/commit.txt" 2>/dev/null || echo "unknown" > "${BACKUP_PATH}/commit.txt"
# 快照 .patch-backup（undo 前的 patch 备份，回滚时覆盖恢复）
if [ -d "${PATCH_BACKUP}" ]; then
  cp -a "${PATCH_BACKUP}" "${BACKUP_PATH}/patch-backup" 2>/dev/null || true
fi
# 备份 public/assets（renderer 产物）
if [ -d "${PUBLIC_DIR}/assets" ]; then
  cp -a "${PUBLIC_DIR}/assets" "${BACKUP_PATH}/assets"
fi
# 备份 web-preload.js / index.html
if [ -f "${PUBLIC_DIR}/web-preload.js" ]; then
  cp "${PUBLIC_DIR}/web-preload.js" "${BACKUP_PATH}/web-preload.js"
fi
if [ -f "${PUBLIC_DIR}/index.html" ]; then
  cp "${PUBLIC_DIR}/index.html" "${BACKUP_PATH}/index.html"
fi
progress 10
trap 'restore_backup' ERR

# ==================== 2. git fetch ====================
step "拉取上游最新代码"
export http_proxy="${PROXY}"
export https_proxy="${PROXY}"
cd "${PROMA_SRC}"
git -c http.proxy="${PROXY}" -c https.proxy="${PROXY}" fetch origin 2>&1 | tee -a "${LOG}"
rc=${PIPESTATUS[0]}
if [ $rc -ne 0 ]; then
  log "git fetch 失败 rc=$rc"
  exit 1
fi
progress 20

# ==================== 3. undo 旧 patch ====================
step "撤销旧版 electron stub patch"
if [ -f "${PATCH_SH}" ]; then
  PROMA_SRC="${PROMA_SRC}" STUB_DIR="${STUB_DIR}" bash "${PATCH_SH}" undo >> "${LOG}" 2>&1 || {
    log "patch undo 失败（可能未 apply，继续）"
  }
else
  log "警告: 未找到 patch 脚本 ${PATCH_SH}"
fi
# 清掉旧 patch 备份：checkout 新代码后 apply 会重新备份（避免跨版本 undo 恢复旧文件污染新代码）
rm -rf "${PATCH_BACKUP}"
progress 25

# ==================== 4. checkout 目标版本 ====================
step "切换到目标版本 ${TARGET_COMMIT}"
# 关键修复：NAS 文件系统会把所有文件标记为可执行（100644→100755），
# git 的 core.filemode=true 误判为“全部文件被修改”导致 checkout 被拒（内容零差异）。
# 1) 关闭 filemode 跟踪（根治 NAS 权限位误判）
# 2) 丢弃已跟踪文件的改动（含文件模式变更 + patch 残留的真实内容修改）
# 3) 清理 untracked 残留（排除依赖/敏感文件；node_modules/.env/.safe-key 均在 .gitignore）
# 注意：这里不能只靠 patch undo——.patch-backup 缺失时 undo 失败，patch 修改过的文件
#       （apps/electron/package.json、ipc.ts、preload/index.ts 等）会残留真实内容修改，
#       必须用 git checkout -- . 从 index 强制恢复。
git config core.filemode false >> "${LOG}" 2>&1 || true
git checkout -- . >> "${LOG}" 2>&1 || { log "git checkout -- . 失败（工作树仍有冲突）"; exit 1; }
git clean -fd -e node_modules -e .env -e .safe-key -e .proma-dev -e bunfig.toml -e .patch-backup >> "${LOG}" 2>&1 || true
git checkout "${TARGET_COMMIT}" >> "${LOG}" 2>&1 || {
  log "git checkout ${TARGET_COMMIT} 失败，尝试 origin/main"
  git checkout origin/main >> "${LOG}" 2>&1 || {
    log "git checkout origin/main 也失败"
    exit 1
  }
}
# 清理 patch 残留
rm -f "${PROMA_SRC}/.patch-applied"
progress 30

# ==================== 5. bun install ====================
step "安装依赖 (bun install)"
cd "${PROMA_SRC}"
# 确保 bunfig.toml 用 npmmirror
cat > bunfig.toml << 'BEOF'
[install]
registry = "https://registry.npmmirror.com"
BEOF
"${BUN}" install >> "${LOG}" 2>&1 || {
  log "bun install 第一次失败，重试..."
  "${BUN}" install >> "${LOG}" 2>&1 || {
    log "bun install 再次失败"
    exit 1
  }
}
progress 50

# ==================== 6. apply patch ====================
step "应用 electron stub patch"
if [ -f "${PATCH_SH}" ]; then
  PROMA_SRC="${PROMA_SRC}" STUB_DIR="${STUB_DIR}" bash "${PATCH_SH}" apply >> "${LOG}" 2>&1 || {
    log "patch apply 失败"
    exit 1
  }
else
  log "警告: 未找到 patch 脚本 ${PATCH_SH}"
fi
touch "${PROMA_SRC}/.patch-applied"
progress 60

# ==================== 7. vite build (renderer) ====================
step "构建前端 (vite build)"
cd "${PROMA_SRC}/apps/electron"
"${BUN}" run build:renderer >> "${LOG}" 2>&1 || {
  log "vite build 失败"
  exit 1
}
progress 80

# ==================== 8. 更新静态文件 ====================
step "更新 server/public 静态文件"
RENDERER_DIST="${PROMA_SRC}/apps/electron/dist/renderer"

if [ -d "${RENDERER_DIST}" ]; then
  # 先复制到 assets.new，再原子交换（避免 mv 瞬间文件不存在）
  if [ -d "${RENDERER_DIST}/assets" ]; then
    rm -rf "${PUBLIC_DIR}/assets.new"
    cp -a "${RENDERER_DIST}/assets" "${PUBLIC_DIR}/assets.new" || {
      log "复制 assets 失败"
      exit 1
    }
    rm -rf "${PUBLIC_DIR}/assets.old"
    if [ -d "${PUBLIC_DIR}/assets" ]; then
      mv "${PUBLIC_DIR}/assets" "${PUBLIC_DIR}/assets.old"
    fi
    mv "${PUBLIC_DIR}/assets.new" "${PUBLIC_DIR}/assets" || {
      log "assets 交换失败，尝试恢复"
      [ -d "${PUBLIC_DIR}/assets.old" ] && mv "${PUBLIC_DIR}/assets.old" "${PUBLIC_DIR}/assets"
      exit 1
    }
    rm -rf "${PUBLIC_DIR}/assets.old"
  fi
  # 更新 index.html
  if [ -f "${RENDERER_DIST}/index.html" ]; then
    cp "${RENDERER_DIST}/index.html" "${PUBLIC_DIR}/index.html" 2>/dev/null || true
  fi
else
  log "警告: ${RENDERER_DIST} 不存在（vite build 产物路径变化？跳过 assets 更新）"
fi
progress 90

# ==================== 9. 重建 web-preload.js ====================
step "重建 web-preload.js"
cd "${APP_DEST}/server"
PROMA_SRC="${PROMA_SRC}" "${BUN}" run build:web-preload >> "${LOG}" 2>&1 || {
  log "web-preload 重建失败（保留旧 web-preload.js）"
}
if [ -f "${PUBLIC_DIR}/web-preload.js" ]; then
  cp "${PUBLIC_DIR}/web-preload.js" "${BACKUP_PATH}/web-preload.js.new" 2>/dev/null || true
fi
progress 95

# ==================== 10. 清理与标记 ====================
step "清理与标记"
cd "${PROMA_SRC}"
NEW_VERSION="$(grep '"version"' "${PROMA_SRC}/apps/electron/package.json" | head -1 | sed 's/.*: "//;s/".*//')"
NEW_COMMIT="$(git -C "${PROMA_SRC}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "${PKGVAR}/.update-status" << EOF
{
  "status": "done",
  "newVersion": "${NEW_VERSION}",
  "timestamp": "$(date -Iseconds)",
  "commit": "${NEW_COMMIT}"
}
EOF
log "写入 .update-status: newVersion=${NEW_VERSION} commit=${NEW_COMMIT}"

# 授权
chown -R aij2022:Users "${PKGVAR}" 2>/dev/null || true

# 清理旧备份（保留最近 3 个）
ls -dt "${BACKUP_DIR}"/*/ 2>/dev/null | tail -n +4 | xargs rm -rf 2>/dev/null || true
# 清理回滚标记（本次更新成功）
rm -f "${BACKUP_DIR}/.rollback-done" 2>/dev/null || true
log "保留最近 3 份备份"

progress 100
log "=== 自更新完成 ==="
echo "[STEP] 更新完成，请重启 Proma"
exit 0

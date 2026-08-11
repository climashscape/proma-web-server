#!/bin/bash
# restore-from-backup.sh — 手动回滚到某次更新前的备份
# 用法: bash restore-from-backup.sh {timestamp}   # timestamp 如 20260811_173000（见 /vol1/@appdata/proma/.backup/）
#
# 环境变量（可覆盖）：
#   PROMA_SRC     Proma 源码目录（默认 ${PKGVAR}/Proma）
#   PKGVAR        数据目录（默认 /vol1/@appdata/proma）
#   APP_DEST      程序目录（默认 /vol1/@appcenter/proma）
#
# 从备份恢复：源码（git checkout 旧 commit）+ assets + web-preload.js + index.html，
# 然后重新 apply patch。完成后提示手动重启。
set -uo pipefail

TIMESTAMP="${1:?用法: restore-from-backup.sh {timestamp}}"
PKGVAR="${PKGVAR:-/vol1/@appdata/proma}"
APP_DEST="${APP_DEST:-/vol1/@appcenter/proma}"
PROMA_SRC="${PROMA_SRC:-${PKGVAR}/Proma}"
BACKUP_DIR="${PKGVAR}/.backup"
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"
PUBLIC_DIR="${APP_DEST}/server/public"
STUB_DIR="${APP_DEST}/server/server/packages/electron-stub"
LOG="${PKGVAR}/update.log"

log() { echo "$(date '+%F %T') $*" >> "${LOG}"; }

if [ ! -d "${BACKUP_PATH}" ]; then
  echo "错误: 备份不存在 ${BACKUP_PATH}"
  echo "可用备份:"
  ls -dt "${BACKUP_DIR}"/*/ 2>/dev/null | head -10 || true
  exit 1
fi

echo "=== 从备份 ${TIMESTAMP} 恢复 ==="
log "=== 手动回滚 ${TIMESTAMP} ==="

# 1. 源码恢复（undo 当前 patch → checkout 旧 commit）
if [ -f "${BACKUP_PATH}/commit.txt" ]; then
  OLD_COMMIT="$(cat "${BACKUP_PATH}/commit.txt")"
  cd "${PROMA_SRC}" || { echo "错误: 无法进入 ${PROMA_SRC}"; exit 1; }
  PROMA_SRC="${PROMA_SRC}" STUB_DIR="${STUB_DIR}" \
    bash "${APP_DEST}/patches/patch-proma.sh" undo >> "${LOG}" 2>&1 || true
  git checkout . 2>/dev/null || true
  git checkout "${OLD_COMMIT}" 2>/dev/null || echo "警告: checkout ${OLD_COMMIT} 失败"
  rm -f "${PROMA_SRC}/.patch-applied"
  # 覆盖恢复 patch 备份（保证与备份时一致）
  if [ -d "${BACKUP_PATH}/patch-backup" ]; then
    cp -a "${BACKUP_PATH}/patch-backup/." "${PROMA_SRC}/" 2>/dev/null || true
  fi
fi

# 2. assets 恢复
if [ -d "${BACKUP_PATH}/assets" ]; then
  rm -rf "${PUBLIC_DIR}/assets.new" "${PUBLIC_DIR}/assets.old" 2>/dev/null || true
  [ -d "${PUBLIC_DIR}/assets" ] && mv "${PUBLIC_DIR}/assets" "${PUBLIC_DIR}/assets.old" 2>/dev/null || true
  cp -a "${BACKUP_PATH}/assets" "${PUBLIC_DIR}/assets" 2>/dev/null || echo "警告: 恢复 assets 失败"
  rm -rf "${PUBLIC_DIR}/assets.old" 2>/dev/null || true
fi

# 3. web-preload.js / index.html 恢复
if [ -f "${BACKUP_PATH}/web-preload.js" ]; then
  cp "${BACKUP_PATH}/web-preload.js" "${PUBLIC_DIR}/web-preload.js" 2>/dev/null || echo "警告: 恢复 web-preload.js 失败"
fi
if [ -f "${BACKUP_PATH}/index.html" ]; then
  cp "${BACKUP_PATH}/index.html" "${PUBLIC_DIR}/index.html" 2>/dev/null || true
fi

# 4. 重新 apply patch（旧代码）
if [ ! -f "${PROMA_SRC}/.patch-applied" ]; then
  PROMA_SRC="${PROMA_SRC}" STUB_DIR="${STUB_DIR}" \
    bash "${APP_DEST}/patches/patch-proma.sh" apply >> "${LOG}" 2>&1 || echo "警告: patch apply 失败（需手动处理）"
  touch "${PROMA_SRC}/.patch-applied" 2>/dev/null || true
fi

# 5. 状态标记
cat > "${PKGVAR}/.update-status" << EOF
{
  "status": "done",
  "newVersion": "rolled-back",
  "timestamp": "$(date -Iseconds)",
  "commit": "$(git -C "${PROMA_SRC}" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "rollback": true
}
EOF

echo "=== 回滚完成，请在 fnOS 应用管理中重启 Proma ==="
log "=== 手动回滚完成 ==="
exit 0

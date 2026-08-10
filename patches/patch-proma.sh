#!/bin/bash
# patch-proma.sh — Proma 源码级 electron stub patch（阶段 2 正式方案）
#
# 背景：PoC 用「物理替换 node_modules/electron/index.js」临时方案；本脚本改为
#       源码级 patch：把 ProMA main 目录下全部 `from 'electron'` import 替换为
#       `from '@proma/electron-stub'`，并在 node_modules 创建 stub 包链接。
#       升级上游时：undo → 拉新代码 → apply。
#
# 用法:
#   bash patch-proma.sh apply    # 备份 + 替换 + 建链接
#   bash patch-proma.sh undo     # 从备份恢复全部文件 + 删链接
#   bash patch-proma.sh status   # 查看当前 patch 状态
#
# 环境变量（均可覆盖）：
#   PROMA_SRC   Proma 源码根目录（必填，无默认值）
#   STUB_DIR    electron-stub 包目录（默认取本脚本同仓库 server/packages/electron-stub）
#   BACKUP_DIR  备份目录（默认 <repo-root>/.patch-backup，随 .gitignore 排除）
set -u

# 定位本脚本所在仓库根目录（patches/patch-proma.sh → repo root）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROMA_SRC="${PROMA_SRC:-}"
if [ -z "$PROMA_SRC" ]; then
  echo "[patch] 错误：必须设置 PROMA_SRC 环境变量指向 Proma 源码根目录" >&2
  echo "[patch] 示例：PROMA_SRC=/opt/Proma bash patches/patch-proma.sh apply" >&2
  exit 1
fi
# 校验源码目录存在
if [ ! -d "$PROMA_SRC/apps/electron/src/main" ]; then
  echo "[patch] 错误：$PROMA_SRC/apps/electron/src/main 不存在，请确认 PROMA_SRC 指向 Proma 源码" >&2
  exit 1
fi

STUB_DIR="${STUB_DIR:-$REPO_ROOT/server/packages/electron-stub}"
# 备份目录按 PROMA_SRC 哈希分目录：多实例（/opt/Proma 与开发目录）互不覆盖，undo 各还原各的
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/.patch-backup/$(printf '%s' "$PROMA_SRC" | cksum | cut -d' ' -f1)}"
SRC_MAIN="$PROMA_SRC/apps/electron/src/main"
LINK_TARGET="$PROMA_SRC/node_modules/@proma/electron-stub"

ACTION="${1:-status}"

# 需要 patch 的文件（main + lib 下 import electron 的全部 .ts）
find_targets() {
  grep -rl "from 'electron'\|from \"electron\"\|require('electron')\|require(\"electron\")" "$SRC_MAIN" --include='*.ts' 2>/dev/null | sort
}

# 阶段 3：依赖 node:sqlite 的文件（Bun 1.3.14 无此模块，替换为 bun:sqlite shim）
find_sqlite_targets() {
  grep -rl "require('node:sqlite')\|require(\"node:sqlite\")" "$SRC_MAIN" --include='*.ts' 2>/dev/null | sort
}

case "$ACTION" in
  apply)
    echo "=== patch-proma apply ==="
    echo "PROMA_SRC=$PROMA_SRC"
    echo "STUB_DIR=$STUB_DIR"
    mkdir -p "$BACKUP_DIR"
    count=0
    # #9：while-read 替代 for-in-$，兼容含空格路径
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      rel="${f#$PROMA_SRC/}"
      bak="$BACKUP_DIR/$rel"
      mkdir -p "$(dirname "$bak")"
      if [ ! -f "$bak" ]; then
        cp "$f" "$bak"
      fi
      # B4：只替换 import 行的 from 'electron'（避免误伤注释/字符串字面量）
      sed -i "/^import /s/from 'electron'/from '@proma\/electron-stub'/g; /^import /s/from \"electron\"/from \"@proma\/electron-stub\"/g" "$f"
      # require('electron') 场景当前源码不存在；保留全局替换仅作兜底（行内含该字面量即替换）
      sed -i "s/require('electron')/require('@proma\/electron-stub')/g; s/require(\"electron\")/require(\"@proma\/electron-stub\")/g" "$f"
      count=$((count+1))
    done < <(find_targets)
    echo "已 patch $count 个文件（备份在 $BACKUP_DIR）"
    # 阶段 3：node:sqlite → bun:sqlite shim（planning 模块；备份机制复用 electron 备份目录）
    sqlite_count=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      rel="${f#$PROMA_SRC/}"
      bak="$BACKUP_DIR/$rel"
      mkdir -p "$(dirname "$bak")"
      if [ ! -f "$bak" ]; then
        cp "$f" "$bak"
      fi
      sed -i "s/require('node:sqlite')/require('@proma\/electron-stub\/node-sqlite-shim')/g; s/require(\"node:sqlite\")/require(\"@proma\/electron-stub\/node-sqlite-shim\")/g" "$f"
      sqlite_count=$((sqlite_count+1))
    done < <(find_sqlite_targets)
    echo "已 patch $sqlite_count 个 node:sqlite 文件（→ bun:sqlite shim）"
    # 创建 node_modules 链接（Bun 可解析 TS main）
    mkdir -p "$PROMA_SRC/node_modules/@proma"
    if [ -e "$LINK_TARGET" ] && [ ! -L "$LINK_TARGET" ]; then
      echo "⚠️ $LINK_TARGET 已存在且非链接，请手动检查"
    else
      ln -sfn "$STUB_DIR" "$LINK_TARGET"
      echo "已创建链接 $LINK_TARGET → $STUB_DIR"
    fi
    echo "剩余 'electron' import（应只剩 @proma/electron-stub）："
    remaining=$(find_targets | wc -l)
    echo "$remaining"
    if [ "$remaining" -gt 0 ]; then
      echo "❌ 仍有 $remaining 个文件残留 'electron' import（多行 import 或新 require 形态），patch 未完全生效"
      exit 1
    fi
    ;;
  undo)
    echo "=== patch-proma undo ==="
    restored=0
    if [ -d "$BACKUP_DIR" ]; then
      while IFS= read -r bak; do
        [ -z "$bak" ] && continue
        rel="${bak#$BACKUP_DIR/}"
        orig="$PROMA_SRC/$rel"
        if [ -f "$bak" ]; then
          cp "$bak" "$orig"
          restored=$((restored+1))
        fi
      done < <(find "$BACKUP_DIR" -type f)
    fi
    echo "已恢复 $restored 个文件"
    rm -f "$LINK_TARGET"
    # #17：清理空的 @proma 目录（若不再被使用）
    rmdir "$PROMA_SRC/node_modules/@proma" 2>/dev/null || true
    echo "已删除链接 $LINK_TARGET"
    ;;
  status)
    echo "=== patch-proma status ==="
    if [ -L "$LINK_TARGET" ]; then
      echo "链接: $LINK_TARGET → $(readlink "$LINK_TARGET")"
    else
      echo "链接: 不存在（未 apply 或已 undo）"
    fi
    remaining=$(find_targets | wc -l)
    echo "仍 import 'electron' 的文件数: $remaining"
    patched=$(grep -rl "@proma/electron-stub" "$SRC_MAIN" --include='*.ts' 2>/dev/null | wc -l)
    echo "已 import '@proma/electron-stub' 的文件数: $patched"
    # 生效判据：链接存在 ≠ 内容已替换（git checkout 可能清掉替换内容而残留链接）
    if [ -L "$LINK_TARGET" ] && [ "$patched" -eq 0 ]; then
      echo "⚠️ 链接存在但无文件 import '@proma/electron-stub'：内容未替换（可能被 git checkout 清掉），请重新 apply"
    fi
    ;;
  *)
    echo "用法: $0 apply|undo|status"
    exit 1
    ;;
esac

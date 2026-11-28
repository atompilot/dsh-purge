#!/bin/sh
# purge-quickstart — 一条命令把「破甲」装到位的入口脚本。
#
# 做三件事，缺一件都等于没装上：
#   1) 装插件（官方 `dsh plugin add` 同一套逻辑，带 SHA256 校验、快照、旧包迁移）
#   2) 对齐加载路径（Electron 优先加载 Resources/app.asar，补丁却写在 Resources/app）
#   3) 打补丁 + ad-hoc 重签 + 逐条校验，最后打印怎么回滚
#
# 用法：
#   sh scripts/quickstart.sh                     # 一键：装 + 对齐 + 校验
#   sh scripts/quickstart.sh --dry-run           # 只看要做什么，不写盘
#   sh scripts/quickstart.sh --status            # 只体检
#   sh scripts/quickstart.sh --revert            # 退回 asar 加载（补丁留在目录里）
#   sh scripts/quickstart.sh --skip-install      # 插件已装，只做对齐
#
# 参数：
#   --version=X.Y.Z    指定发行版本（默认取最新发行）
#   --profile=NAME     插件装哪个 profile（macOS 默认 desktop，Linux 默认 web）
#   --no-sign          跳过 ad-hoc 重签（只在明确知道后果时用）
#   --recover-legacy   1.7.24 起：从官方归档取回被污染的 .dshpurge.bak（从 ≤1.7.23 升级时用）
#   --yes              非交互（本脚本不提问，保留给包装脚本）
#   --app=PATH         桌面应用路径（macOS，默认 $DSH_APP 或 /Applications/DeepSeek Harness.app）
#
# 不做的事：不卸载旧包装、不改 npm 源、不关 TLS/SHA256、不自动重启宿主。
set -eu

REPO="atompilot/dsh-purge"
REF="${PURGE_REF:-master}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}/scripts"

APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
PROFILE_OVERRIDE=""
VERSION=""
DRY_RUN=""
NO_SIGN=""
RECOVER=""
SKIP_INSTALL=""
ACTION="align"

for arg do
  case "$arg" in
    --help|-h)
      if [ -r "$0" ]; then sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      else echo "用法：sh quickstart.sh [--dry-run] [--status] [--revert] [--version=X.Y.Z] [--profile=NAME] [--app=PATH] [--no-sign] [--recover-legacy]"; fi
      exit 0 ;;
    --dry-run) DRY_RUN="--dry-run" ;;
    --status) ACTION="status" ;;
    --revert) ACTION="revert" ;;
    --skip-install) SKIP_INSTALL="1" ;;
    --no-sign) NO_SIGN="--no-sign" ;;
    --recover-legacy) RECOVER="--recover-legacy" ;;
    --yes) : ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --profile=*) PROFILE_OVERRIDE="${arg#--profile=}" ;;
    --app=*) APP="${arg#--app=}" ;;
    *) echo "未知参数：$arg（--help 看用法）" >&2; exit 3 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in
  Darwin) MODE="desktop" ;;
  Linux) MODE="cli" ;;
  *) die "只支持 macOS / Linux。Windows 用 scripts/install.ps1。" ;;
esac

# ---- 定位脚本来源：仓库内直接读兄弟文件；curl | sh 时按 REF 下载到临时目录 ----
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

SELF_DIR=""
case "$0" in
  */*) SELF_DIR="$(CDPATH= cd -P "$(dirname "$0")" 2>/dev/null && pwd -P)" || SELF_DIR="" ;;
esac

need_file() { # $1=文件名
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/$1" ]; then
    printf '%s\n' "$SELF_DIR/$1"
    return 0
  fi
  if [ -z "$TMP" ]; then TMP="$(mktemp -d "${TMPDIR:-/tmp}/purge-quickstart.XXXXXX")"; fi
  if [ ! -f "$TMP/$1" ]; then
    have curl || die "需要 curl 才能下载 $1"
    curl -fsSL --connect-timeout 20 --max-time 90 "$RAW/$1" -o "$TMP/$1" || die "下载失败：$RAW/$1"
  fi
  printf '%s\n' "$TMP/$1"
}

# ---- 桌面版：解析运行时 ----
RUNTIME=""
if [ "$MODE" = "desktop" ]; then
  [ -d "$APP" ] || die "找不到 $APP（用 --app= 指定 .app 路径）"
  PLIST="$APP/Contents/Info.plist"
  [ -f "$PLIST" ] || die "$APP 缺少 Info.plist，不是可用的桌面安装"
  EXE_NAME="$(/usr/bin/plutil -extract CFBundleExecutable raw -expect string -n -o - "$PLIST" 2>/dev/null || true)"
  [ -n "$EXE_NAME" ] || die "读不到 CFBundleExecutable"
  RUNTIME="$APP/Contents/MacOS/$EXE_NAME"
  # PURGE_RUNTIME 只用于测试/非标准布局：明确指定用哪个 Electron 运行时跑脚本。
  [ -n "${PURGE_RUNTIME:-}" ] && RUNTIME="$PURGE_RUNTIME"
  [ -x "$RUNTIME" ] || die "找不到可执行文件：$RUNTIME"
fi

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
# 默认 profile 按"哪个真的初始化过"选：新桌面壳可能用 web，旧 Desktop CLI 用 desktop。
# 猜错会把插件装进一个宿主根本不加载的 profile，所以只在两侧都有/都没有时才回落到 desktop。
DEFAULT_PROFILE="web"
[ "$MODE" = "desktop" ] && DEFAULT_PROFILE="desktop"
if [ "$MODE" = "desktop" ] && [ ! -f "$HOME_DIR/profiles/desktop/package.json" ] && [ -f "$HOME_DIR/profiles/web/package.json" ]; then
  DEFAULT_PROFILE="web"
fi
PROFILE="${PROFILE_OVERRIDE:-${PURGE_PROFILE:-$DEFAULT_PROFILE}}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
PLUGIN_JSON="$PROFILE_DIR/package.json"

say "宿主        $([ "$MODE" = "desktop" ] && echo "$APP" || echo "CLI ($(command -v dsh || echo 'dsh 未在 PATH'))")"
say "profile     $PROFILE  ($PROFILE_DIR)"
say "数据目录    $HOME_DIR"

if [ "$ACTION" = "align" ]; then
  [ -f "$PLUGIN_JSON" ] || die "$PROFILE_DIR 还没有初始化。先打开一次 DSH 让它建好 profile（或用 --profile= 指定实际 profile）。"
  if [ "$MODE" = "desktop" ] && pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
    die "DSH 正在运行。先完整退出（⌘Q，不是关窗口），再跑本脚本；浏览器/终端窗口关掉不算。"
  fi
fi

ALIGN="$(need_file purge-align.mjs)"
run_align() {
  if [ "$MODE" = "desktop" ]; then
    ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$ALIGN" "$@" --app="$APP" --profile="$PROFILE" --home="$HOME_DIR"
  else
    have node || die "CLI 模式需要 node（≥18）"
    node "$ALIGN" "$@" --profile="$PROFILE" --home="$HOME_DIR"
  fi
}

# ---- 只有桌面版有 asar 层；status/revert 直接转发 ----
if [ "$ACTION" = "status" ]; then
  if [ "$MODE" = "desktop" ]; then run_align status; else say "CLI/Web 模式没有 asar 加载层，装完即用。"; fi
  exit 0
fi
if [ "$ACTION" = "revert" ]; then
  [ "$MODE" = "desktop" ] || die "CLI/Web 模式没有 asar 层，无需 revert"
  run_align revert $DRY_RUN
  exit $?
fi

# ---- 1) 装插件 ----
read_installed() { # 桌面版不一定有 node，用宿主自带的 Electron 运行时读
  [ -f "$PLUGIN_JSON" ] || return 0
  if [ "$MODE" = "desktop" ]; then
    ELECTRON_RUN_AS_NODE=1 "$RUNTIME" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write((p.dependencies&&p.dependencies["dsh-purge-community"])||"")' "$PLUGIN_JSON" 2>/dev/null || true
  elif have node; then
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write((p.dependencies&&p.dependencies["dsh-purge-community"])||"")' "$PLUGIN_JSON" 2>/dev/null || true
  fi
}
INSTALLED="$(read_installed)"

if [ -n "$SKIP_INSTALL" ]; then
  say "插件        跳过安装（--skip-install）"
elif [ -n "$INSTALLED" ] && [ -z "$VERSION" ]; then
  say "插件        已装：dsh-purge-community $INSTALLED（要换版本用 --version=X.Y.Z）"
else
  say "插件        $([ -n "$INSTALLED" ] && echo "当前 $INSTALLED，改为 $VERSION" || echo "未安装，开始安装")"
  BOOTSTRAP="$(need_file bootstrap-install.mjs)"
  if [ -n "$DRY_RUN" ]; then
    say "            [dry-run] 跳过安装"
  elif [ "$MODE" = "desktop" ]; then
    ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$BOOTSTRAP" ${VERSION:+--version=$VERSION} --profile="$PROFILE"
  else
    node "$BOOTSTRAP" ${VERSION:+--version=$VERSION} --profile="$PROFILE"
  fi
fi

# ---- 2) 对齐 + 3) 打补丁 + 重签 + 校验 ----
if [ "$MODE" != "desktop" ]; then
  say ""
  say "✓ 插件已装。CLI/Web 模式没有 asar 加载层，重开 dsh 进程即生效。"
  say "体检：node \"$ALIGN\" status --profile=\"$PROFILE\""
  exit 0
fi

say ""
set +e
run_align align $DRY_RUN $NO_SIGN $RECOVER
RC=$?
set -e

say ""
if [ -n "$DRY_RUN" ]; then
  say "↑ 以上是计划，没有写盘。去掉 --dry-run 才会真正执行。"
  exit $RC
fi
say "下一步：重新打开 DSH。验收两条："
say "  1) ps -Ao args | grep dsh-desktop-host   → 路径应含 /Resources/app/dsh/，不是 app.asar"
say "  2) 新开一个会话，确认不再自述「作为 AI 语言模型」"
say "回滚：sh scripts/quickstart.sh --revert"
exit $RC

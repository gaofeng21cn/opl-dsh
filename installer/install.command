#!/bin/bash
# Install the verified official application and the separately versioned OPL bundle.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OPL_SUITE_ROOT:-$HOME/Library/Application Support/OPL DSH Suite}"
APPS="${OPL_APPLICATIONS_DIR:-$HOME/Applications}"
APP="$APPS/DeepSeek Harness.app"
ZIP_SHA='68e7f1b51bc5a93451a77ceabba9d736020b8157470cfc9fb2585454d9d4d70318c35758d6f4de969b497809940edec6f36d920aa1f3c6d3f0326bc219e92f78'
URL='https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.1.7-rc.2-mac-arm64.zip'
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo '此基线支持 Apple Silicon Mac。'; exit 1
fi
mkdir -p "$ROOT/cache" "$APPS"
LOCK="$ROOT/install.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ "$OWNER_PID" =~ ^[0-9]+$ ]] && ! kill -0 "$OWNER_PID" 2>/dev/null; then
    rm "$LOCK/pid"
    rmdir "$LOCK"
    mkdir "$LOCK"
  else
    echo '另一个安装过程正在运行，请等待完成。'; exit 1
  fi
fi
echo "$$" > "$LOCK/pid"
STAGE=''
cleanup() {
  if [[ -n "$STAGE" ]]; then rm -rf "$STAGE"; fi
  rm -f "$LOCK/pid"
  rmdir "$LOCK"
}
trap cleanup EXIT
if [[ ! -d "$APP" ]]; then
  ARCHIVE="${OPL_OFFICIAL_ARCHIVE:-$ROOT/cache/deepseek-harness-0.1.7-rc.2.zip}"
  if [[ ! -f "$ARCHIVE" ]]; then
    echo '正在下载 DeepSeek 官方桌面版…'
    curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' "$URL" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  ACTUAL="$(shasum -a 512 "$ARCHIVE" | cut -d ' ' -f 1)"
  if [[ "$ACTUAL" != "$ZIP_SHA" ]]; then echo '官方安装包校验失败，请删除缓存后重试。'; exit 1; fi
  STAGE="$(mktemp -d "$ROOT/cache/unpack.XXXXXX")"
  ditto -x -k "$ARCHIVE" "$STAGE"
  codesign --verify --deep --strict "$STAGE/DeepSeek Harness.app"
  codesign -v -R='anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"' "$STAGE/DeepSeek Harness.app"
  spctl --assess --type execute "$STAGE/DeepSeek Harness.app"
  mv "$STAGE/DeepSeek Harness.app" "$APP"
fi
codesign -v -R='anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"' "$APP"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
if [[ "$VERSION" != '0.1.7-rc.2' ]]; then echo "此增强基线尚未验收官方版本 $VERSION；未修改应用。"; exit 1; fi
export NODE_USE_SYSTEM_CA=1
export ELECTRON_RUN_AS_NODE=1
"$APP/Contents/MacOS/DeepSeek Harness" "$HERE/install.mjs" "$APP" "$ROOT" "$HERE" "$@"

cask "opl-dsh" do
  version "0.1.7-rc.2,2"
  sha256 "41472bc7ed6c198663a66782fb400fbe8d5424848e939c25aafb78168bea7bc1"

  url "https://github.com/gaofeng21cn/opl-dsh/releases/download/dsh-v#{version.csv.first}-opl.#{version.csv.second}/OPL-DSH-Enhancements.zip"
  name "OPL DSH"
  desc "Official DeepSeek Harness desktop with OPL Gateway and Codex collaboration"
  homepage "https://github.com/gaofeng21cn/opl-dsh"

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  installer script: {
    executable: "/bin/bash",
    args:       ["-c", <<~EOS, "--", staged_path],
      set -euo pipefail
      /bin/bash "$1/install.command" --no-launch
      root="${OPL_SUITE_ROOT:-$HOME/Library/Application Support/OPL DSH Suite}"
      expected=$(/usr/bin/plutil -extract suiteSha256 raw -o - "$1/artifact.json")
      actual=$(/usr/bin/plutil -extract suiteSha256 raw -o - "$root/installation.json")
      [[ "$actual" == "$expected" ]] || { echo 'OPL DSH 安装记录与增强包不符。' >&2; exit 1; }
    EOS
    sudo:       false,
  }

  # Only remove shortcuts owned by this suite. Keep the official app and user data.
  uninstall script: {
    executable: "/bin/bash",
    args:       ["-c", <<~EOS],
      root="$HOME/Library/Application Support/OPL DSH Suite"
      app="$HOME/Applications/OPL DSH.app"
      marker="$app/Contents/Resources/opl-launcher-owner.txt"
      if [[ -f "$marker" && "$(cat "$marker")" == "$root" ]]; then
        rm -rf "$app"
      fi
      shortcut="$HOME/Applications/OPL DSH.command"
      if [[ -f "$shortcut" ]] && /usr/bin/grep -Fq "$root/launch.command" "$shortcut"; then
        rm -f "$shortcut"
      fi
    EOS
    sudo:       false,
  }

  caveats <<~EOS
    打开 ~/Applications/OPL DSH.app，即可使用官方桌面与 OPL 增强。
    安装时获取最新官方桌面，并自动配置 Codex Skill。
    官方桌面和增强分别更新；Cask 版本仅标识安装器版本。
    卸载仅移除 OPL 快捷入口，保留官方桌面、数据及 Codex Skill。
  EOS
end

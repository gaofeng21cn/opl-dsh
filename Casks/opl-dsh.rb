cask "opl-dsh" do
  version "0.1.7-rc.2,1"
  sha256 "810c5ad2147e9a3afb905ded1974dc0727a60d7731087b24c566dec8d7cbdc60"

  url "https://github.com/gaofeng21cn/opl-dsh/releases/download/dsh-v#{version.csv.first}-opl.#{version.csv.second}/OPL-DSH-Enhancements.zip"
  name "OPL DSH"
  desc "Official DeepSeek Harness desktop with OPL Gateway and Codex collaboration"
  homepage "https://github.com/gaofeng21cn/opl-dsh"

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  installer script: {
    executable: "/bin/bash",
    args:       [staged_path.join("install.command"), "--no-launch"],
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

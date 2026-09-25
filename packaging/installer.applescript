on run
  set progress total steps to -1
  set progress description to "正在安装 OPL DSH"
  set progress additional description to "检查官方最新桌面、下载并安装增强。首次下载可能需要几分钟。"
  set resourcePath to POSIX path of (path to resource "payload")
  set logPath to POSIX path of (path to home folder) & "Library/Logs/OPL-DSH-Install.log"
  try
    do shell script "/bin/mkdir -p " & quoted form of (POSIX path of (path to home folder) & "Library/Logs")
    do shell script "/bin/bash " & quoted form of (resourcePath & "/install.command") & " >" & quoted form of logPath & " 2>&1"
    set progress completed steps to 1
  on error
    display dialog "安装未完成。请先退出已打开的 DeepSeek Harness，再检查网络连接后重试。\n安装日志：" & logPath buttons {"好"} default button "好" with title "OPL DSH"
  end try
end run

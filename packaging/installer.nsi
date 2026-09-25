Unicode true
!include "MUI2.nsh"
Name "OPL DSH · ${OFFICIAL_VERSION}"
OutFile "${OUTPUT}"
RequestExecutionLevel user
VIProductVersion "${NUMERIC_VERSION}"
VIAddVersionKey "ProductName" "OPL DSH 安装器"
VIAddVersionKey "ProductVersion" "${OFFICIAL_VERSION}"
VIAddVersionKey "FileVersion" "${OFFICIAL_VERSION}"
VIAddVersionKey "FileDescription" "DeepSeek Harness 官方桌面与 OPL 增强在线安装器"
VIAddVersionKey "LegalCopyright" "One Person Lab"
SetCompressor /SOLID lzma
ShowInstDetails show
BrandingText "DeepSeek Harness 官方桌面 + OPL 增强"
!define MUI_WELCOMEPAGE_TITLE "安装 OPL DSH"
!define MUI_WELCOMEPAGE_TEXT "为当前用户安装最新官方 DeepSeek Harness 桌面、OPL Gateway 和 Codex 协作增强。$\r$\n$\r$\n安装器联网读取官方更新清单；首次下载约 300 MB。已有会话和设置会保留。$\r$\n$\r$\n安装前请退出已打开的 DeepSeek Harness。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PAYLOAD}/*"
  DetailPrint "正在读取官方更新清单、验证并安装桌面与 OPL 增强…"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\install.ps1"' $0
  StrCmp $0 "0" success
  SetErrorLevel 1
  MessageBox MB_OK|MB_ICONSTOP "安装未完成。请退出 DeepSeek Harness 后重试。日志位于 %APPDATA%\OPL DSH Suite\installer.log。" /SD IDOK
  Abort
  success:
  SetErrorLevel 0
SectionEnd

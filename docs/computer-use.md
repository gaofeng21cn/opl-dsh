# KimiCU WinCU

DSH 检查 Windows x64 主机是否达到 Windows 10 build 18362（1903）或更高版本，并提供官方 Kimi Code 插件安装入口：

`/plugins install https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip`

Windows 适配沿用 KimiCU 的 MCP 工具协议：在插件安装后，DSH 仅尝试调用 PATH 中的 `kimi-cu.exe`，先完成初始化，再转发原始工具名；工具变更类操作仍要求当前会话明确选择“完全访问”，每次调用都有超时和取消处理。Windows 插件的独立可执行路径和发布清单仍未在公开文档中固定，因此找不到 `kimi-cu.exe` 或握手失败时会明确报告不可用，不下载或执行未知程序，也不读取凭据。macOS 继续使用官方固定路径和安装器的签名校验。

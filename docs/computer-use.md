# KimiCU Computer Use

OPL DSH 可以把本机 [KimiCU](https://kimi.com) 的桌面操作能力接入原生 DSH 会话。接入只增加一个 `computer_use` 工具；应用发现、窗口读取、截图、点击、输入和拖拽仍由 KimiCU 自己执行，OPL 不维护第二套桌面自动化。macOS 新机安装 OPL DSH 时会自动安装并配置 KimiCU；安装失败不会阻断 DSH，原因写入套件目录的 `kimi-cu-installation.json`。

## 使用条件

- macOS 14 或更高版本，Apple Silicon。
- `/Applications/KimiCU.app` 已安装并可信，Bundle ID 为 `ai.kimi.cu`，Team ID 为 `2J9472RW75`。新机由 OPL 安装器自动安装，不需要另装。
- KimiCU 的辅助功能和屏幕录制权限已授予，`kimi-cu doctor` 的检查通过。
- KimiCU 的 XPC 服务可用。权限通过但服务失败时，工具会报告真实错误；不会退化成另一套截图或输入实现。
- 桌面变更要求当前 DSH 会话显式选择“完全访问”。只读观察不需要扩大文件沙箱权限。

## 调用方式

模型先使用 `computer_use` 的 `action` 参数调用 KimiCU 原始工具。常用流程：

1. `list_apps` 配合 `running_only: true` 找到目标应用。
2. `get_app_state` 读取截图与无障碍树；之后的点击可使用返回的 `snapshot_id` 和节点 `index`。
3. 在完全访问会话中调用 `click`、`type_text`、`press_key`、`scroll`、`set_value`、`drag` 等动作。
4. 重新读取状态确认结果；工具返回的“已投递”不等于业务结果已完成。

`action` 支持 KimiCU 0.6.6 的原始工具：

```text
list_apps, list_windows, get_window, launch_app, get_app_state,
get_window_state, activate_window, click, type_text, paste, press_key,
scroll, set_value, perform_secondary_action, select_text, drag,
drag_paths, debug_tap
```

`args` 原样传给对应 KimiCU 工具，因此各动作的字段以 `kimi-cu mcp -s user` 返回的 schema 为准。截图会保存为 DSH 附件，并以图像块返回给模型。

## 安装与升级

macOS 安装器从 KimiCU 官方 `https://cdn.kimi.com/kimi-computer-use/latest/version.json` 选择与当前架构匹配的稳定版本，下载后校验官方 SHA-256，再校验 Developer ID 签名、公证、Team ID、Bundle ID、版本和架构。校验通过后才原子替换 `/Applications/KimiCU.app`；替换后执行 KimiCU 官方 `install`，并完成 MCP `initialize`、`tools/list` 和必需工具检查。Windows 安装器在读取 macOS 路径或联网前直接跳过 KimiCU，不写 `/Applications`。

已有可信的相同或更高版本会保留并重新检查配置，不降级。已有身份不可信的 KimiCU 会保留原应用并拒绝自动覆盖。下载、验签、安装或配置失败时，旧版本会恢复，DSH 继续安装，结果写入 `kimi-cu-installation.json`。首次安装后仍需在 macOS 系统设置中授予 KimiCU 辅助功能和屏幕录制权限；安装器不会代替用户接受系统权限。

## 权限与失败边界

- 只读动作：`list_apps`、`list_windows`、`get_window`、`get_app_state`、`get_window_state`。
- 变更动作：启动或激活应用、点击、输入、粘贴、按键、滚动、设置值、次级操作、选择文本、拖拽和 `debug_tap`。
- KimiCU 的 MCP 进程按 DSH 会话复用；DSH 会话取消时发送 MCP 取消通知，插件卸载时关闭自有进程。
- 缺少 KimiCU、权限不足、XPC 服务失联或 KimiCU 返回错误时，工具失败且不自动重试。用户修复 companion 后可重新观察或执行。
- 截图可能包含桌面内容。调用前应确认目标应用和任务范围；不要用桌面自动化绕过应用自身的认证、授权或安全确认。

## 当前验证

本机 KimiCU 0.6.6 的签名、Bundle ID、Team ID、辅助功能、屏幕录制、SkyLight 和后台输入检查通过；MCP `initialize` 与 `tools/list` 可用。验收时 XPC `permissionStatus` 服务返回失败，因此实际 `list_apps` 不能视为通过。DSH 侧的协议、取消、结果映射和权限门禁由自动测试覆盖；完整的桌面操作仍需在 KimiCU 服务恢复后执行。

# KimiCU WinCU

DSH checks Windows x64 hosts for Windows 10 build 18362 (1903) or newer and exposes the official Kimi Code plugin install entry:

`/plugins install https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip`

The public materials do not provide a verifiable plugin installation path or a stable DSH-callable stdio/MCP command, JSON-RPC protocol, or tool list. DSH therefore reports the unavailable state explicitly and only shows the official install guidance; it does not claim the tools are callable, download or execute unknown programs, or read credentials. Computer-use calls still require the explicit permission gate.

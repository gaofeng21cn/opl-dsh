官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增强版围绕官方 DSH 0.2.2-rc.5 适配模型、网页搜索、会话清理和桌面更新流程，并修复部分外部会话标题异常。

### 变更

- 网页搜索默认使用登录后的 OPL Gateway 与 GPT-6.1 Sol，并可在官方“网页搜索与获取”设置中选择其他提供方。
- 新增 EAC Kimi K3.1 Pro（通过官方 Kimi Code 接入，保持思考开启）以及 OFM Tidepool Alpha Free（推荐 OpenCode）。
- macOS 可在退出 Desktop 后，将指定 DSH 会话回收至当前用户的废纸篓，并保留可核验的原路径与恢复信息；会话清理改为仅作用于选定 Desktop 配置。
- 修复外部 Harness 回传历史上下文时覆盖会话标题，以及空会话切换 Harness 后误固定旧标题的问题。
- 官方桌面更新后，增强包可按实际安装版本准备和刷新，并合并同目标下的更新及回收路线修复。
- Windows 可选 Git Bash 候选更新至 0.169.0-opl-gitbash.20261116.1；已有 0.160.1 候选仍可继续使用。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- macOS 会话回收仅支持同一存储卷上的目标，并要求当前用户废纸篓可正常访问；执行前需退出使用该配置的 Desktop。
- 新版 Windows Git Bash 候选仅支持 Windows x64、完全访问任务及已安装的 Git for Windows，且为未签名的自建开发版本。
- Kimi K3.1 Pro 接入要求保持思考开启。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

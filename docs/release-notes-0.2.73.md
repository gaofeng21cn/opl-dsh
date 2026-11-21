官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

OPL DSH 在官方 DSH 0.2.2-rc.5 基础上增强执行组合、Codex 任务委派及会话清理体验，并保留官方会话和配置的归属。

### 变更

- 执行组合可为独立配置且可用的原生 Provider 自动生成只读 DSH fallback；用户已有默认或停用选择仍优先生效，OPL Gateway、OFM 和外部 CLI 专属来源不受影响。
- MiniMax 官方 mcode 集成默认开启，可在“设置 → 执行与组合”停用；停用后隐藏其 Provider、模型、组合和账号入口并拒绝新轮次，重新启用可恢复已有配置、凭据及历史会话。
- “协作与自动化”新增 Codex 任务委派一键配置，可配置完成通知、项目续作和异常接手；主审退出后可尝试恢复原项目，配置状态和可用能力会在界面中展示。
- 改进 Windows 和 macOS 的 DSH 会话清理流程，支持按归档、精确标题或会话 ID 预览和清理，并在确认安全后退出及按需重新打开 Desktop；清理前保留运行中、受保护或关联任务中的会话。
- 统一项目外工作入口的关闭图标，并让执行目录重载时同步 MiniMax 集成开关而不丢弃页面草稿或保存反馈。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- MiniMax 集成开关不代表真实 MiniMax 服务、额度或各 CLI 版本的产品验收已完成。
- Codex 异常恢复仅支持已核实的退出及本地能力，恢复失败或服务不可用时会保留入队意图并提示；WSL 接手仍需另行验证。
- 协调器当前明确适配的 Codex 版本为 0.167.0、0.169.0 和 0.169.1；未知版本或无法确认进程终态时不会自动推进。
- macOS 会话清理依赖对应进程观察与锁机制，Windows 清理和正常退出能力以目标 Desktop 进程身份核实为前提。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

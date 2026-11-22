官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增强了执行组合的管理与模型适配，并修复 StepCode 回复和组合路由相关问题。

### 变更

- 新增七个 EAC 执行组合，标明量子校准和机器翻译两款专用模型的用途。
- 可直接移除已保存的自定义组合；移除后，其他组合的勾选修改仍需保存。
- 修复 StepCode 工具执行后可能没有回复的问题，并调整推理选项和强度标签的显示。
- 修复组合被移除或停用时的对话路由处理，支持重新启用旧 Pi 配置。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 量子校准和机器翻译模型仅可手动尝试。
- 若对话尚未发送首条消息时移除了当前所选组合，需重新选择组合后再发送。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

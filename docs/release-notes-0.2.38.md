官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新增强了 Auto Review 的模型选择，并改进外部 Harness 的取消处理、Codex 回复展示和失败诊断。

### 变更

- Auto Review 新增独立的“决策模型”选项，可选择 BambooNode StartLux；它与普通 reviewer 分开显示，不进入普通聊天模型列表。
- 用户手动停止任务后，即使 CLI 迟到返回成功，任务仍保留为取消状态；Codex 回复同时接收流式内容和完成事件正文，避免漏答或重复展示。
- Codex、ZCode 和 ACP 的失败信息可显示已识别的错误类别、HTTP 状态或 RPC 错误码等诊断，同时不回显上游原始消息或响应内容。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- StartLux 仅在 Host 已注册且确认可用时显示；缺少 API Key、请求失败或结果不确定时不会放行审查。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

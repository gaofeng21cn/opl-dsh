官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次为华为云 MaaS 增加 DeepSeek V4 Flash 和 Kimi K2.6 的官方执行路线，并调整两款模型的推理选项展示。

### 变更

- 华为云 DeepSeek V4 Flash 可通过官方 DSH 使用；华为云 Kimi K2.6 可通过官方 Kimi Code 使用。GLM-5.2 仍使用 ZCode。
- DeepSeek V4 Flash 提供 high、max 两档推理强度，默认 high；Kimi K2.6 不显示思考强度选项。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 使用华为云模型需配置独立的华为云 MaaS API Key；模型权限取决于华为云实际响应。
- DeepSeek V4 Flash 不提供额外的思考开关；Kimi K2.6 没有已确认的推理强度档位。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

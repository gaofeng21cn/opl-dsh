官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

OPL DSH 的 Auto Review 新增 Jev 决策模型路线，可为选择 Auto 权限的 DSH 或 ZCode 会话提供工具审批；免费路线无需个人 API Key，也可配置 TypeSafe 个人路线。

### 变更

- 在“设置 → 执行与组合 → 工具审批”的“决策模型”列表中，可选择 OpenCode · Jev / Jev 1.13 Free。
- 可在“设置 → 模型供应商”配置 TypeSafe · Jev API Key，再选择个人决策路线；密钥仅保存在 Windows Credential Manager，未配置时不显示该路线。
- Jev 路线仅用于工具审批，不会出现在普通聊天模型列表中；只有结果完整、一致且允许结论达到置信度要求时才放行。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Jev 免费服务可能限流或不可用；审核失败、不确定或结果不符合要求时不会放行，也不会自动切换到其他路线。
- TypeSafe 个人路线需要有效 API Key，且仅在支持 Windows Keyring 的平台提供。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增加 BambooNode StartLux 作为可选的 Auto Review 审查路线，并调整 Windows 上华为云 MaaS API Key 的保存与旧凭据迁移方式。

### 变更

- 可在“设置 → 模型供应商”添加 BambooNode · StartLux 并保存 API Key，在“执行与组合”的工具审批设置中将其用作固定审查路线。
- Windows 上 BambooNode 和华为云 MaaS 的 API Key 保存到 Windows Credential Manager，不写入明文凭据文件；旧版华为云明文 Key 只有在迁入后精确读回一致才会删除，迁移失败则保留原件。
- Windows 以外的华为云凭据继续使用官方凭据服务。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- StartLux 仅用于无工具的 Auto Review，不作为普通聊天或执行模型，也不绑定执行会话；请求失败、结果缺失、未知选择或不确定结果均拒绝放行。
- Windows Credential Manager 不阻止同一 Windows 用户下已运行的恶意程序调用系统凭据 API。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

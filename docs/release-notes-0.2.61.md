官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新增强了 OPL Gateway Gemini 的 Antigravity 使用体验，改善 OFM 的独立更新与迁移保留，并提升更新失败时的识别与说明。

### 变更

- OPL Gateway Gemini 4 Argon 和 Gemini 3.8 Flash 默认使用官方 Antigravity CLI，通过 Gateway 原生 Gemini 接口和分组凭据接入，无需 Google 登录；OpenCode 仍可作为备选。支持图片输入，Windows 使用时需要 Git Bash。
- OFM 改为在 profile 中独立管理程序文件，由 OFM 自身负责更新；迁移、恢复和重装时保留已安装版本及文件。OFM 的虚拟路由不再作为可执行模型出现在 OPL 对话选择器中，外部 Harness 需绑定具体模型。
- 新增 Kilo Inkling 2 Small 的 OFM 免费路由。
- 更新流程对准备和校验失败提供更明确的分类；遇到 GitHub Releases API 明确限流时，可改从同仓库公开发布页读取固定版本信息，其他 403 仍报告失败。
- 修复 Antigravity 工具组结束与回合结算的时序问题。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Antigravity 仅支持明确选择的完全权限，不支持 Auto Review；会话中途编辑需改用 OpenCode。
- Gemini 3.1 Pro 当前不再提供 OPL Gateway 的 OpenCode 组合。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

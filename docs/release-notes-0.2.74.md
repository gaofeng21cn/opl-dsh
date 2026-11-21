官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

官方 DSH 增强层现可为 OPL Gateway 的 Gemini 4 Carbon 和 Hydrogen 新增 Pi Coding Agent 执行组合，并改进组合筛选、名称展示与权限选择。

### 变更

- 可在“执行与组合”中启用 Gemini 4 Carbon 或 Hydrogen 的 Pi 组合，Pi 复用原生 Gemini 凭据并使用独立会话目录。
- 组合列表支持按模型名称、模型 ID、来源或 Harness 筛选，并分别展示模型名称与调用 ID。
- 手动添加组合时会按当前 Harness 显示可用权限档位；推荐组合也会显示完全权限提示。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Pi Gemini 组合当前接收文本，并要求在当前会话明确选择完全权限。
- 仅适用于默认 OPL Gateway 地址；自定义 Chat 地址不能推断原生 Gemini 地址，需保留或使用 OPL 默认原生端点的组合。
- Antigravity 失败不会自动切换到 Pi 或 OpenCode。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

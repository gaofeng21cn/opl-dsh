官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新跟进官方 DSH，并增强 Gateway Gemini、OFM 管理及外部 Harness 的会话恢复与推理设置体验。

### 变更

- Gateway Gemini 4 Argon 和 Gemini 3.8 Flash 默认可使用官方 Antigravity CLI，通过 Gateway 凭据接入，无需 Google 登录；OpenCode 仍可作为备选。
- OFM 可在独立目录中自行更新，OPL 重装会保留其版本；新增 Kilo Inkling 2 Small 免费模型路由。
- 改善外部会话编辑恢复和推理档位读取；更新准备失败会提供更明确的错误分类。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Antigravity 仅支持完全权限，不支持 Auto Review；目前只支持编辑首条消息，中途编辑可使用 OpenCode，且 Antigravity 失败不会自动切换到 OpenCode。
- Antigravity 在 Windows 上需要 Git for Windows Bash；Gemini 3.1 Pro 不再登记为可用的 Gateway 组合。
- OFM 的虚拟路由不作为 OPL 对话选择器中的可执行模型；外部 Harness 需绑定已适配的具体模型。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增强扩展了 OFM 免费模型的可选执行引擎，并改善了 Kimi 请求失败提示、Harness 会话恢复及官方桌面环境兼容性。

### 变更

- 新增 OFM 免费模型路由：Kilo Code 支持 Beam Free、Xing4.0；OpenCode 支持 Beam Free、Nemotron 3.5 Super VL Free、GLM 5.3 Flash Free，以及经 OFM 转发的 GLM 5.3 Flash Free、DeepSeek V4.1 Flash Free；Big Pickle 可通过 OpenCode 官方免费通道使用。
- 恢复已有 Harness 会话或导入历史会话时，改为接续原会话，避免意外创建替代会话。
- Kimi Code 的上游渠道失败现在会显示相应诊断；每步请求限制为一次，不会自动重发。
- 改善与官方桌面运行时的安装兼容性，并修复官方会话及外部控制调用的兼容问题。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Kimi 的错误提示不会恢复上游已停用的模型、缺失的账户路由或额度；失败后需由用户决定是否重发。
- Big Pickle 的 OpenCode 组合不提供推理强度选择。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

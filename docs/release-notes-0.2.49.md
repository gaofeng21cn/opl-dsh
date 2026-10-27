官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新扩展了跨 Harness 的消息编辑与用量展示，并调整网页搜索、ZCode 推理档位及部分模型的执行路线。

### 变更

- 网页搜索改为统一使用 GPT-6.1 Sol。
- Codex、Claude、Grok、MiniMax、ZCode、OpenCode、Kilo、Kimi、Pi 和 Pool 支持在原 DSH 对话中编辑并重发消息；底层需要分支时由后台接替，侧边栏仍保留同一 DSH 会话。
- 外部 Harness 可展示已确认的 Token 用量，并将上下文占用作为独立读数呈现；估算的上下文占用与 Token 账单分开。
- ZCode 的 GLM-5.2 推理档位调整为 high/max，默认 max。
- 新增经 Kilo 执行、由 OFM 转发的 Nemotron 3 Super 120B 路线。
- 模型切换与发送按会话顺序处理；切换失败时不会自动改用旧模型或重发请求。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 消息编辑仅在会话空闲且历史身份可准确核对时提供；带附件、已压缩或替换的消息，以及原生子任务和受协作台账管理的任务不支持该入口。结果不明或历史无法核对时会阻断操作，不自动重放。
- Token 字段缺失或无法精确确认时不显示相应用量；上下文占用不代表 Token 账单。模型切换失败后，需重新选择成功再发送。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新完善了无需工作区的对话体验与模型加载，并扩展 OpenCode 的模型路由；同时调整了任务回传通知、设置界面和 Windows 快捷方式。

### 变更

- 项目外可直接新建对话；会话恢复期间显示状态提示，恢复后使用官方输入框。模型目录加载时显示加载状态，已迁移的外部历史会话按需恢复，不再阻塞目录读取。
- OpenCode 新增 OPL Gateway 的 Gemini 4 Argon、Gemini 3.8 Flash 和 Gemini 3.1 Pro 组合；支持的部分 OFM 模型可走 OpenCode 官方免费通道，并在组合名称中标明。
- 新任务回传通知缩短为状态和 deliveryId。收到通知后可用 `control CLI: receive --delivery <deliveryId> --consumer <stable-id>` 领取完整验收说明；旧通知和回执仍兼容。
- OPL 设置项采用更接近官方偏好设置的行样式；日常上下文用量查看改由官方计量器负责。
- Windows 安装会在开始菜单和桌面创建 DeepSeek Harness 快捷方式。
- 外部 Harness 的指定客户端访问限制会以固定提示说明；原生 DSH 委派失败不再回显上游原文。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 新增的 OPL Gateway Gemini 路由仅覆盖 Gemini 4 Argon、Gemini 3.8 Flash 和 Gemini 3.1 Pro。
- Longcat 2.5 Preview 与 Nemotron 3.5 Lightning 使用 OpenCode 官方免费通道，不会回退到 OFM 转发或其他模型。
- 要求通过指定官方客户端访问、且本次确认无法使用的免费渠道会从选择列表隐藏；MiMo Code 和 Muse Code 不再默认登记或提示安装，但现有程序和显式配置保留。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

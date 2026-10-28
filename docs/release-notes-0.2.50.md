官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新新增 DSH 会话清理 Skill，并改进 OFM 模型可用性识别与组合列表；首次安装 OFM 插件时改用官方 v2.7.2 发布包。

### 变更

- 安装器新增「DSH 会话清理」Skill，可按明确指定的范围核对会话及关联记录，并默认移入 Windows 回收站；使用前需指定清理范围和授权方式。
- OFM 可用目录不再包含的模型会标记为当前不可用，相关组合不再出现在可选列表中；当实时目录和路由信息完整时，会清理对应的自动生成组合，保留用户手动创建的组合。
- 旧版 Nemotron 组合会调整为 Kilo 路由。
- 首次安装 OFM 插件改用官方 v2.7.2 发布包，并校验固定摘要后保存到 profile，供安装及后续修复使用。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 当前官方 SessionPersistence 接口没有删除能力，因此永久删除会话受限；清理 Skill 无法确认安全删除协议时会停止，默认回收站操作不等同于永久删除。
- OFM 发布包下载失败或摘要校验失败时，安装会停止，不会改用旧版源码包替代。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->

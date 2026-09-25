# OPL DSH 开发约定

本仓库是官方 DSH 桌面增强套件。只维护 OPL 插件、配置、协作 Skill 和一键安装器。开发依赖固定用于复现；用户安装通过官方桌面更新清单选取最新版本，Harness 核心复用官方包，不修改应用资源，不引入另一套 Agent 循环，不恢复旧 fork 的桌面壳或会话格式补丁。

- 只向 `gaofeng21cn/opl-dsh` 写入，不向 DeepSeek 上游提交。
- README 与新增用户文档以中文为主；描述已实现、已验证的行为。
- 修改前确认真实调用者与官方接口；Host 和 Client 分别严格类型检查。
- 改动验证：`npm run typecheck`、`npm run build`、`npm test`。构建后才能运行 artifact 测试。
- 安装与运行变化必须用未修改的官方应用在隔离数据目录验收。真实模型调用不得把凭据写入日志、测试或仓库。
- 官方安装包按 SHA-512、Developer ID、Bundle ID 和版本校验；不得关闭 TLS 校验或篡改应用签名。
- 安装器只写套件拥有的文件；保留用户修改和旧数据。运行中的 profile 不可更新。
- 核心服务保留为 runtime peer。升级公开 API 后同时验证 Client 注册、RPC 参数、模型流和官方工具执行。
- `main` 是唯一长期维护主线；旧 fork 仅保留在 Git 历史及 `opl-baseline-20260925` 标签。

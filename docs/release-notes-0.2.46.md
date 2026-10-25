官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本版适配官方 DeepSeek Harness 0.2.1-rc.3，完善执行组合、OFM 新模型发现和 MiniMax 账号管理。

### 变更

- 执行设置新增 OFM 新模型发现提示，区分官方、推荐、仅可手动尝试、排除及尚未适配的模型，不自动启用未知路线。
- 整理执行组合的批量选择、手动添加和已启用列表，调整网络代理选项的排列与间距。
- MiniMax 官方账号支持明确选择中国站或国际站、查看登录状态、退出、取消授权及授权超时处理；国际站提供大陆网络使用提示。
- 完善 Harness 路由、推理档位展示、无进展等待保护和 Windows KimiCU 适配；取消单轮总时长限制，避免中断持续有进展的长任务。
- 升级官方 DSH 依赖至 0.2.1-rc.3，并适配系统通知的会话状态读取。

完整改动见 [PR #38](https://github.com/gaofeng21cn/opl-dsh/pull/38)。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:manual -->

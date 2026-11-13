官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本版跟进上游 DSH，并修复 macOS 启动器在长临时目录下无法创建更新控制通道的问题。

### 变更

- 修复 macOS 临时目录路径过长导致 Suite 启动器返回 `EINVAL`、官方桌面无法启动的问题。
- 跟进上游 DSH 的 Antigravity 进程清理、OFM Kilo ERNIE 5.5 Flash、外部消息编辑恢复和推理设置修复。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS 更新控制通道真实 server/client 回归：通过
- macOS arm64 与 Windows x64 官方桌面隔离验收：待发布流程完成

### 已知限制

- 官方桌面两平台 feed 必须收敛到同一版本后，联合 Release 才能公开。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

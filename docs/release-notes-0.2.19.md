## OPL DSH v{{VERSION}}

官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}`  ·  OPL 增强：`{{VERSION}}`

本版将官方 DSH 与 OPL 增强作为一套联合稳定版本发布。`release-manifest.json` 是版本配对清单；tag、官方两个平台 feed、增强包摘要和构建产物必须一致。

### 变更

- 修复 Windows 官方桌面启动与版本读取，支持带空格路径的 EXE 和原生 Harness `.cmd/.bat` 启动器。
- Windows 原生 Bash 使用 Git for Windows，支持通过 `OPL_GIT_BASH_PATH` 指定路径；缺少 Git Bash 时给出明确错误。
- Codex 协作支持读取官方会话权限、在空闲会话切换权限及创建时显式选择权限；按工作目录创建任务时绑定官方 Workspace。
- 兼容两种 `session.wait` 参数格式；Skill 备份移至 `skill-backups`，避免重复发现活动 Skill，并保留已有配置与任务记录。
- 增加显式 Windows ACL 修复入口，补齐真实 Git Bash 工具、设置页面和会话重启恢复的隔离验收。
- 建立 macOS arm64 打包、同一安装包双平台验收、公开资产回读及 Homebrew 跟随的稳定发布流程。

### 验证

- Host/Client 类型检查：通过
- RPC、模块边界、格式检查：通过
- 构建与自动测试：通过
- macOS arm64 原版官方桌面隔离验收：通过
- Windows 原版官方桌面隔离验收：通过；真实 Git Bash 工具使用显式授权的 full-access Session
- 官方 Client 设置页面、模型设置 RPC、Messages/Chat Completions 本地模型流、官方工具执行和重启恢复：通过
- 官方应用签名与 `app.asar`：验收前后未改变
- 两平台均验收本次交付的增强包字节；证据记录源提交 `{{SOURCE_COMMIT}}`

### 已知限制

- 官方版本与候选阶段以以上实际版本为准；官方版本带 `-rc` 时，本 Release 不代表上游已发布对应正式版。
- 官方 rc.2 的 Windows restricted token 仍限制 Git Bash 外部程序；已验证的真实 Git Bash 工具路径使用显式授权的 `danger-full-access`。ACL 修复不会由 dispatch 自动执行。
- Windows 外部 Harness 尚未完成运行验收；本地模型 fixture 不代表真实 Gateway、凭据或外部模型质量已验收。
- 直接打开官方桌面不会启动外部维护更新器；安装器建立的 OPL 维护入口或已启用自动启动的 Codex Skill 会在启动前每小时检查联合 Release。官方桌面继续按 DeepSeek 原生更新机制升级。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败会保留当前安装；更新器成功前不会替换正在使用的 profile。

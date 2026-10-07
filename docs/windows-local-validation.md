# Windows 官方 Desktop 本地验证

本地增强补丁基于 OPL 轻量增强套件 0.2.18，复用未修改的官方 DeepSeek Harness Desktop 0.2.0-rc.2。控制桥将显式权限请求交给官方 preset 服务，读取实际 sandbox 与 approval 值；运行中的 Session 拒绝权限变更。按 cwd 创建任务时先解析官方 Workspace，再将新 Session 绑定该项目。

Windows 启动器为 EXE 路径加引号。构建使用相对归档名避免 Git Bash tar 误解析盘符，Typert 的协议包复制解引用依赖链接。安装器通过 Electron 读取 ASAR 内版本。

原生 dispatch 支持 `--preset`。未指定时保留官方默认权限。Windows 增强包通过 Git for Windows 的 `bash.exe` 提供原生 Git Bash，并继续使用官方 sandbox 与 subprocess。Git Bash 缺失时会在启动阶段给出明确错误；可用 `OPL_GIT_BASH_PATH` 指定带空格的绝对路径。工作目录若因官方 Windows ACL 后端返回 Win32 5，可由用户在管理员 PowerShell 中运行 Skill 的 `repair-acl --cwd <目录> --confirm yes`，再创建新的 `workspace-write` Session 验证；该修复不会由 dispatch 自动执行。验证还发现官方 rc.2 的 Low-integrity restricted token 会阻止 MSYS2 外部程序创建 `\\BaseNamedObjects\\msys-2.0*`，所以 Git Bash 的 `workspace-write` 仍受 `0xC0000022` 限制；Git Bash 外部程序的可用路径是用户明确授权的 `danger-full-access`，直到官方后端支持 integrity-level 选择。

主审已在官方 Desktop 上验证权限读取、创建时 danger-full-access、Skill 自动启动及 OpenAI 协议 DeepSeek 模型实际执行 git rev-parse。默认 DeepSeek 分组的旧迁移 Key 被服务端拒绝且触发手动凭据保护，已在停机并备份凭据文件后移除该失效引用，账号刷新后默认 DeepSeek 通道已实测执行只读 Git 命令并返回完成反馈。

Host/Client 类型检查、构建、权限与 bridge 聚焦测试、RPC 生成测试通过。仓库全部测试仍有 Windows 路径、POSIX fixture、缺少 yaml 测试依赖和外部 Harness 并发测试失败，未声明发布质量门禁通过。无需覆盖官方应用资源或迁移 Session 格式即可安装此增强补丁。

安装器将 Skill 备份保存在 Codex home 的 `skill-backups`，避免把旧备份当成同名活动 Skill；更新保留当前 ledger 与配置。官方 Skill 区分原生 dispatch 的同 task、新 operation 续作和旧 fork helper 的 continue，并规定反馈领取、独立验收、人工等待和 heartbeat 停止条件。

官方 Windows 0.2.0-rc.2 与本地增强包已通过隔离 profile 安装、四个设置页面挂载、Messages/Chat Completions 本地协议 fixture、工具调用和重启恢复检查。验收前后 app.asar 摘要一致；本地 fixture 不替代真实渠道凭据测试。

控制桥兼容原生 helper 的平铺 session.wait 参数与旧 CLI 的 request 封装，参数仍需 sessionId 与非负 turn。隔离官方实例已验证创建时显式权限、权限回读与切换及精确 Workspace 归属；Settings 窗口自动化出现一次时序失败后，有界重试通过，此 UI 测试稳定性仍需关注。

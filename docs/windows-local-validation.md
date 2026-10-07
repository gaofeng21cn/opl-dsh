# Windows 官方 Desktop 本地验证

本地增强补丁基于 OPL 轻量增强套件 0.2.18，复用未修改的官方 DeepSeek Harness Desktop 0.2.0-rc.2。控制桥将显式权限请求交给官方 preset 服务，读取实际 sandbox 与 approval 值；运行中的 Session 拒绝权限变更。按 cwd 创建任务时先解析官方 Workspace，再将新 Session 绑定该项目。

Windows 启动器为 EXE 路径加引号，安装器通过 Electron 读取 ASAR 内版本。构建与原生启动器由 Windows runner 验证。

原生 dispatch 支持 `--preset`。未指定时保留官方默认权限。Windows 增强包通过 Git for Windows 的 `bash.exe` 提供原生 Git Bash，并继续使用官方 sandbox 与 subprocess。Git Bash 缺失时会在启动阶段给出明确错误；可用 `OPL_GIT_BASH_PATH` 指定带空格的绝对路径。工作目录若因官方 Windows ACL 后端返回 Win32 5，可由用户在管理员 PowerShell 中运行 Skill 的 `repair-acl --cwd <目录> --confirm yes`，再创建新的 `workspace-write` Session 验证；该修复不会由 dispatch 自动执行。验证还发现官方 rc.2 的 Low-integrity restricted token 会阻止 MSYS2 外部程序创建 `\\BaseNamedObjects\\msys-2.0*`，所以 Git Bash 的 `workspace-write` 仍受 `0xC0000022` 限制；Git Bash 外部程序的可用路径是用户明确授权的 `danger-full-access`，直到官方后端支持 integrity-level 选择。

PR #4 的作者报告了本机真实渠道下的权限读取、创建时 danger-full-access、Skill 自动启动及 Git 命令验证。维护者的托管验证使用隔离 profile 与本地协议 fixture，不读取或修改用户凭据；Windows smoke 在显式 full-access Session 中通过真实 Bash 工具执行 `git --version`，并回读其工作目录中的标记文件。

Host/Client 类型检查、构建、权限与 bridge 聚焦测试、RPC 生成测试通过。ACL 校验按 Windows 路径规则处理，macOS/Linux 可运行同一校验 fixture；POSIX 安装器 fixture 仅在具有 `/bin/bash` 的宿主执行。Windows CI 执行含空格路径的 `.cmd/.bat` 原生 Harness 回归及 ACL 测试，官方 Windows 资格验证失败会直接使工作流失败。无需覆盖官方应用资源或迁移 Session 格式即可安装此增强补丁；CI 和隔离资格验证不等于发布或用户实际安装完成。

安装器将 Skill 备份保存在 Codex home 的 `skill-backups`，避免把旧备份当成同名活动 Skill；更新保留当前 ledger 与配置。官方 Skill 区分原生 dispatch 的同 task、新 operation 续作和旧 fork helper 的 continue，并规定反馈领取、独立验收、人工等待和 heartbeat 停止条件。

官方 Windows 0.2.0-rc.2 与本地增强包已通过隔离 profile 安装、四个设置页面挂载、Messages/Chat Completions 本地协议 fixture、工具调用和重启恢复检查。验收前后 app.asar 摘要一致；本地 fixture 不替代真实渠道凭据测试。

控制桥兼容原生 helper 的平铺 session.wait 参数与旧 CLI 的 request 封装，参数仍需 sessionId 与非负 turn。隔离官方实例验证创建时显式权限、权限回读与切换及精确 Workspace 归属。UI 验收先等待首次引导关闭；设置容器意外消失时最多重新打开一次，面板错误与运行异常仍会使验收失败。重启验证通过官方接口恢复保存的 Session 后，再读取它的执行组合。

# OPL DSH

OPL DSH 为官方 DeepSeek Harness 桌面增加两种工作方式。你可以在同一个 DSH 对话界面里选择模型和对应的官方执行引擎，也可以从 Codex 委派任务给 DSH，在原来的 Codex 聊天中收到结果并验收。

## 下载安装

图形安装器支持 macOS Apple Silicon 和 Windows x64，无需预装 Git、Node.js 或其他 OPL 应用。Linux x64 另提供基于官方 DSH CLI/Web 的源码迁移入口，使用独立 profile，不安装或修改 Electron Desktop。

### 图形安装器

| 系统                  | 下载                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [Mac 安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg)       |
| Windows · x64         | [Windows 安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) |
| Linux · x64           | 源码构建 + 官方 CLI/Web，见 [Linux 本地迁移](#linux-本地迁移)                                                                            |

手动运行安装器前请先退出 DeepSeek Harness。安装器会联网下载并校验官方桌面、安装 OPL 插件和 Codex Skill。OPL 安装器未签名，首次可能需要按系统提示允许打开。升级会保留已有登录、会话、设置以及用户修改过的 Skill。

### 首次打开

在 Windows 或 macOS 打开 **DeepSeek Harness**（Mac 默认安装在 `~/Applications/DeepSeek Harness.app`）。在应用内选择 OPL Gateway、DeepSeek 官方或稍后登录。以后仍可在设置中连接账户。[首次启动与登录](docs/first-run.md)

在「插件 → 已安装插件」可分别管理 **OPL DSH 基础增强**、**OPL 执行组合**和**OPL 跨引擎协作**。跨引擎协作需要启用执行组合。要用官方自动审批，先在插件管理中确认 Auto Review 已启用，再在会话中选择 Auto。[工具审批设置](docs/auto-review.md)

## 新用户使用指南

- [从 Codex 委派任务给 DSH](docs/codex-task-delegation.md) · 配好连接，派发第一个任务，在原聊天接收并验收结果。
- [给模型选一个官方执行引擎](docs/model-harness-guide.md) · 连接模型来源，安装 CLI，启用组合，在 DSH 对话中调用工具。
- [OPL DSH 日常使用指南](docs/everyday-guide.md) · 在项目外聊天、编辑重发、清理指定会话，按自己的习惯调整通知、权限和统计。

### 终端安装

macOS · Apple Silicon：

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.sh)"
```

Windows · x64，在 PowerShell 中运行：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.ps1)))
```

也可使用 Homebrew：

```sh
brew tap gaofeng21cn/opl-dsh https://github.com/gaofeng21cn/opl-dsh.git
brew install --cask gaofeng21cn/opl-dsh/opl-dsh
```

### Linux 本地迁移

Linux x64 使用官方 `dsh` CLI/Web，目标 profile 默认为 `opl-linux`，不会改写现有 `web` profile。先准备 Node.js 24.9 或更新版本、pnpm，以及与 `dist/artifact.json` 中 `officialVersion` 相同的官方 DSH，然后执行：

```sh
git clone https://github.com/gaofeng21cn/opl-dsh.git
cd opl-dsh
npm ci --ignore-scripts
npm run build
node installer/install-linux.mjs "dist/OPL DSH 一键安装"
"$HOME/.local/share/OPL DSH Suite/launch-opl-linux.sh"
```

启动器在 `127.0.0.1:4180` 监听并打印带认证信息的地址。可用 `OPL_PROFILE_NAME` 指定另一个非 `desktop`、非 `web` 的独立 profile，用 `OPL_LINUX_PORT` 修改端口。安装仍通过官方插件管理器完成，KimiCU、DSH 会话清理 Skill 和增强层自动更新目前不提供 Linux 实现；更新时请重新构建并运行同一安装入口。

## 主要能力

- **OPL Gateway**：在「网关账户」登录、查看余额和获准使用的分组，再到「模型供应商 → OPL Gateway → 选择模型」勾选本机要用的模型。
- **Our Free Model**：保留[上游插件](https://github.com/Ebony-Vinyl/dsh-our-free-model)的渠道、登录、模型发现和更新功能。执行设置提示新模型及适配状态，不自动启用未知路线。见[模型插件](docs/model-plugins.md)。
- **模型 + Harness 组合**：在「执行与组合」按引擎批量启用推荐搭配，或手动添加其他受支持的搭配。独立配置的原生模型供应商也可使用 DSH，适用条件见[适配与支持范围](docs/harness-adaptation.md)。
- **DSH 官方智能体团队**：在“协作与自动化 → 角色与执行”给官方角色绑定 DSH、Codex 或 Claude Code 组合。角色、人设、Skills、成员身份、消息和任务板归官方管理，OPL 关联外部执行会话并接入官方协作工具。绑定适用于新会话与新成员。见[跨 Harness 团队接入](docs/cross-harness-team.md)。
- **OPL 领域智能体**：另装 OPL Framework 和相应领域 Package 后，可以在新会话选择已激活的 MAS、MAG、OBF 等官方 Agent 预设。[配置领域智能体](docs/cross-harness-team.md#opl-领域智能体预设)
- **Codex 任务委派**：Windows 和 Apple Silicon Mac 用户可在「协作与自动化 → Codex 任务委派」点「一键配置」。任务完成通知把结果送回原聊天；需在主审中断后继续处理的项目，还可启用项目续作。[配置与派发示例](docs/codex-task-delegation.md)
- **SuperAgent 仓库协作**：继承 DeepSeek SuperAgent 原型的 GitHub／可选飞书接单、授权策略、工单、执行和管理面板。macOS 和 Linux 在“协作与自动化”打开独立页面后配置。见[SuperAgent](docs/superagent.md)。
- **Auto Review 工具审批**：使用官方自动审批，每个会话需选择官方 `auto` 权限预设。OPL reviewer 默认关闭，启用后可配置独立 reviewer、预算和 ZCode 外部审批；关闭后官方 Auto 继续使用当前会话模型。支持专用 codex-auto-review、[BambooNode StartLux](docs/bamboo-startlux-auto-review.md) 和 [Jev](docs/jev-auto-review.md) 决策模型。见[工具审批](docs/auto-review.md)。
- **MiniMax 官方账号**：通过 mcode 登录中国站或国际站，支持登录状态、退出、取消授权与超时处理。官方 mcode 集成默认开启，可在“模型供应商 → MiniMax 官方账号（mcode）→ 编辑”中停用或重新启用。停用时隐藏相关模型和组合，保留凭据和历史会话。见[MiniMax 账号与 mcode](docs/minimax-code.md)。
- **对话与会话管理**：在工作区选择器点「× 不在项目中工作」即可开始项目外对话。支持的外部引擎可以[编辑消息并原地重发](docs/stop-edit.md)，开启「增强会话统计」后可切换当前对话或历史累计。[Todo](docs/todo-status.md)显示实际任务状态，也可启用[后台任务系统通知](docs/desktop-notifications.md)。Windows 和 macOS 可通过 Codex 将指定会话移到回收站或废纸篓。见[日常使用指南](docs/everyday-guide.md)。
- **Agent 应用交接**：`inspect_mcp_app_host` 按当前对话检查工具和资源能力；无嵌入式 UI 时保留原 owner 的结构化结果与专业应用入口。见 [MCP Apps 支持范围](docs/mcp-apps.md)。
- **网页搜索**：登录 OPL Gateway 后，网页搜索默认通过 Gateway 使用 GPT-6.1 Sol。可在官方「网页搜索与获取」设置中选择其他搜索提供方。

### 常用执行组合

| 来源与模型                      | Harness                                | 使用前提                                                            |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| OPL DeepSeek V4.1 Flash         | DSH                                    | 对应 Gateway 分组可用                                               |
| OPL GPT                         | Codex CLI                              | 分组与 CLI 已就绪                                                   |
| OPL Claude Opus 5.5、Fable 5.2  | Claude Code                            | Claude、AWS、Kiro 渠道独立选择                                      |
| OPL Grok 4.7                    | Grok Build                             | 分组与 CLI 已就绪                                                   |
| OPL Gemini 4 Carbon、4 Hydrogen | Antigravity CLI（默认），可启用 Pi 或 OpenCode | 使用 Gateway Gemini 分组凭据，无需 Google 登录；Antigravity 支持图片与 Git Bash |
| MiniMax M3.1-Flash、M3          | mcode                                  | 官方账号；仅支持明确授权的完全访问                                  |
| OFM 免费模型与虚拟路由          | 按来源选择已适配 Harness               | 见 [OFM 组合](docs/harness-adaptation.md#our-free-model-组合)       |

通过默认 OPL Gateway 连接时，Gemini 4 Carbon 和 Hydrogen 还可选择 Pi；这两个 Pi 组合只接收文本，须在会话中明确选择完全权限。MiniMax 两区都已登录时，会话使用供应商设置中选定的地区。

“已适配”表示实现了接入，不保证免费渠道随时可用。不同渠道保留独立身份，失败不会自动换模型或换源；外部 Harness 不支持当前权限时拒绝启动，不会自动提升权限。推理档位按模型与 CLI 实际能力提供。

外部 CLI 可分别设置继承环境、直连或 HTTP/HTTPS 代理，入口为 **设置 → 执行与组合 → 执行引擎与网络代理**。Windows Git Bash 能力因 Harness 而异，见[Windows 验证与限制](docs/windows-local-validation.md)及 [Codex Git Bash 候选版](docs/codex-gitbash-candidate.md)。

图片输入按模型来源与 CLI 实际能力开放，保留官方附件引用、输入顺序及编辑时的原图片；不支持图片的组合会在发送前拒绝。详见[模型与 Harness 架构](docs/model-harness-architecture.md)。

## 更新与数据

| 要更新的内容 | 操作入口 |
| --- | --- |
| 官方 DeepSeek Harness 桌面 | 使用应用自己的官方更新入口；需要完整安装包时也可重新运行套件安装器。 |
| OPL 增强层 | 打开「通用设置 → 更新」。兼容更新准备好后可点「立即更新」。也可选择仅提醒、退出后自动更新（默认）或空闲时自动重启更新。有任务运行时先完成或停止任务，再立即更新。 |
| 各家执行引擎 | 打开「执行与组合 → 执行引擎与网络代理 → 管理更新」，检查、勾选并并行更新；也可选择自动检查后仅提醒或自动安装。标注「单独管理」的引擎按其安装渠道更新。[引擎更新指南](docs/model-harness-guide.md#更新引擎) |
| OFM 插件 | 打开「OFM 模型服务」，使用插件自己的升级入口。[模型插件](docs/model-plugins.md) |

Linux CLI/Web 用户按上面的[本地迁移步骤](#linux-本地迁移)重新构建安装。通过 Homebrew 安装的用户可运行：

```sh
brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh
```

增强包和缓存保存在 OPL DSH Suite，官方 profile、登录、会话与设置位于 `~/.dsh`；重新安装保留已有数据。Linux 的 Suite 默认位于 `~/.local/share/OPL DSH Suite`，OPL 执行与会话数据跟随实际 CLI profile。Windows 上的 BambooNode 和 TypeSafe 个人 Key 使用 Windows Credential Manager；MiniMax 账号凭据由官方 mcode 管理。

准确版本、平台与资产摘要见[最新 Release](https://github.com/gaofeng21cn/opl-dsh/releases/latest)。发布与校验流程见[发布约定](docs/release-policy.md)与[发布 SOP](docs/release-sop.md)。

## 开发与文档

- [开发、数据位置与验证](docs/development.md)
- [官方桌面兼容验证](docs/compatibility.md)
- [模型与 Harness 架构](docs/model-harness-architecture.md)
- [官方能力复用检查](docs/dsh-reuse-audit.md)
- [外部 Harness 适配](docs/harness-adaptation.md)
- [Computer Use](docs/computer-use.md)
- [发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)

## 关于

本仓库由 One Person Lab 独立维护，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。

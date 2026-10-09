# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

OPL DSH 提供 OPL Gateway 登录、分组模型管理、搜索、Codex 协作和模型 + Harness 执行组合。桌面、Agent 循环、工具执行及权限管理均由官方 DSH 或所选官方 Harness 提供；增强能力在同一个插件包中按模块维护，统一安装与更新。发布规则见[发布约定](docs/release-policy.md)，执行流程见[稳定发布 SOP](docs/release-sop.md)。

## 下载安装

### Homebrew（macOS · Apple Silicon）

```sh
brew tap gaofeng21cn/opl-dsh https://github.com/gaofeng21cn/opl-dsh.git
brew install --cask gaofeng21cn/opl-dsh/opl-dsh
```

安装完成后直接打开 `~/Applications/DeepSeek Harness.app`。官方桌面会从默认 `~/.dsh` profile 加载 OPL 增强；安装器建立的 OPL 维护入口仅用于维护和增强更新。

### 终端一键安装

macOS · Apple Silicon：

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.sh)"
```

Windows · x64，在 PowerShell 中运行：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.ps1)))
```

命令会获取最新 OPL 增强发布包，校验后调用同一套安装器；无需安装 Git、Node.js 或手动解压文件。

### 图形安装器

| 系统                  | 下载                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS · Apple Silicon | [Mac 一键安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg)       |
| Windows · x64         | [Windows 一键安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) |

1. 下载并打开对应平台的一键安装器。
2. 安装器读取 DeepSeek 官方桌面更新清单，下载并验证当前官方桌面，再安装增强插件和 Codex Skill。首次安装需要联网。
3. 在应用内选择 **OPL Gateway**、**DeepSeek 官方**，或 **稍后登录**。

以后直接从 Mac「应用程序」或 Windows「开始菜单」打开官方 **DeepSeek Harness**。无需先安装 Node.js、OPL App 或 OPL Framework，也无需手动填写 Gateway 模型地址和密钥。Windows 的安装后自动启动与 Codex Skill 自动启动使用独立于调用方 Job 的套件启动器；WMI 不可用时明确报错，可从 OPL DSH 快捷方式打开。直接打开官方桌面不会触发外部 OPL 更新器；需要联合版本检查时使用 OPL 维护入口或已启用自动启动的 Codex Skill。

这是在线安装器：内含 OPL 增强，安装时自动下载约 300 MB 的官方桌面。Mac 打开 DMG 中的安装应用；Windows 直接运行 EXE。OPL 安装器未签名，首次需按系统提示允许打开；下载的官方桌面会校验 SHA-512 和 DeepSeek 发布者签名。

安装或升级前请退出已打开的 DeepSeek Harness。安装器会复用现有官方桌面和 profile；登录、会话、运行配置、协作设置和用户修改过的 Skill 会保留。安装完成后日常只需打开官方 **DeepSeek Harness**，不需要打开兼容维护入口。

## 增强能力

- **OPL Gateway**：应用内登录，统一管理账户、余额、连接状态和 DeepSeek、OpenAI 协议、Grok、Gemini、AWS、Kiro 分组权限、密钥和本机激活状态。Gateway 页面不维护模型目录；登录后把可用路由注册为 DSH 原生模型页面中的 **OPL Gateway** Provider。默认模型 ID 为 `deepseek-flash`，对话选择器显示 **模型 · Harness**；模型来源显示在展开列表的分组标题中。
- **分组模型路由**：按账号权限自动管理各分组密钥，并保留每个模型的明确分组归属。模型归属决定实际协议：DeepSeek 模型通过官方 DeepSeek adapter 使用 Messages，GPT 等 OpenAI 协议模型通过官方 `dsh-llm-pi-ai` 协议库使用 OpenAI。两组不会因为请求失败而互相回退，仍由 DSH 执行工具和管理会话。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，可启动 DSH、连续派发任务、等待结果、读取持久化反馈。设置中可修复 Skill、调整自动启动和可选通知桥。
- **模型 + Harness 组合**：DSH 原生会话继续使用官方会话列表、消息流和输入框；所有已就绪的模型 + Harness 组合都在同一个模型选择器中显示。选择 Codex CLI、Claude Code 或 Grok Build 后，当前官方会话仍使用同一输入框和消息流，后台将本轮请求转发给绑定的官方 Harness 并把结果回写；组合、权限和恢复记录由后台维护。支持的组合沿用该菜单的推理强度选择，已提供的档位统一显示为低、中、高、极高、最大、超高，实际可选档位仍由模型决定；切换时显示目标组合与等待状态，首次发送时启动对应 Harness。自动生成的外部组合继承当前 DSH 会话的读写权限；显式设置为只读的组合仍保持只读。Claude Code 的受限任务依赖官方 sandbox 后端；显式完整访问使用官方 bypassPermissions，允许工作目录外访问。外部任务可按每轮 `writeScope` 的精确文件或目录范围并行；重叠写入、未声明范围的项目写入、构建和安装保持串行。该声明用于调度，不改变工具权限。从 Codex 或对话内协作工具 `delegate` 派出的外部任务绑定一个真实的官方 DSH 会话：它出现在对应项目的官方会话列表侧栏，按普通会话查看、续作和人工审批；设置中不再有独立的“外部任务”页面。
- **MiniMax 官方账号组合**：接入官方 MiniMax CLI `mcode` 的 ACP 模式并使用官方账号登录；只提供两个模型组合（M3.1-Flash-Preview 默认 `max`、M3 默认开启思考），推理设置按官方能力可选，不需要 MiniMax Code 图形界面自动化，也不使用 OPL Gateway 的 MiniMax 密钥。Windows Git Bash 固定后端需支持 Shell 回读的 mcode 候选版；官方 0.6.3 默认 PowerShell，不能仅靠 SHELL 环境变量切换。详见[官方 MiniMax 账号与 mcode](docs/minimax-code.md)。

- **网页搜索**：登录 OPL Gateway 后，DSH 原生 `web_search` 使用 OPL 的搜索路由；`web_fetch` 继续使用官方公共 HTTP 提供方。搜索固定使用低成本的 `gpt-6-luna`，无需额外配置；不提供独立搜索设置页或本地统计。
- **简化首启**：统一账户选择，支持稍后登录；完成后不再重复提示，不导入其他 OPL 应用的登录状态。

推理菜单只列具体档位，不提供“默认”：GPT-6 Astra/Sol/Luna 与 Claude Opus 5.5 为 `low/medium/high/xhigh/max`（GPT 不提供 `ultra`）；Grok 4.7 为 `low/medium/high/xhigh`；MiniMax M3.1 为 `low/medium/high/xhigh/max`，M3 为思考开关。选项按实际 Harness 核对，Grok 通过 ACP 设置并回读。所有 DeepSeek-V4.1-Flash 渠道未指定档位时使用 `max`；已明确选择的档位和每模型会话记忆保留。

设置分为 **OPL Gateway、模型、Harness、运行配置、协作与自动化**。Gateway 账号页负责凭据和权限；模型页复用 DSH 原生设置，OPL Gateway 作为一个来源按分组展开。Harness 页检测本机程序、版本与路径，提供官方安装更新入口。运行配置只引用模型、Harness 和权限，不再重复保存连接和协议；协作与自动化管理任务验收、外部接入和 Skill。外部任务不单列设置页，按官方会话在对应项目侧栏查看和处理。

对话输入栏直接使用官方 DSH 的会话 UI，并在模型选择器中显示“模型 · Harness”。所有已就绪组合都可在当前会话选择；官方 DSH 组合直接切换模型，外部 Harness 组合由 Host 在同一官方会话的模型请求阶段转发。切换到外部 Harness 时，已有会话的文本、工具调用和结果会作为上下文交接；历史推理内容不会交接，直接附件暂不支持。未配置官方凭据的 DeepSeek 模型不会作为可用选项；未登录 DeepSeek 官方账号时不请求远端模型目录，已保存的组合仍显示为不可用。默认 DeepSeek Flash 只走 DeepSeek 分组，不要求 OpenAI 协议权限；用户在模型页显式启用后，才会加入 OpenAI 协议渠道。同名模型的渠道分别保留；Claude Opus 5.5 可选 AWS/Kiro。账号页展示上游返回的分组倍率，组合始终绑定所选渠道。GPT 使用 OpenAI 协议分组。

Codex 协作保留 DSH 的权限与问题确认。后台主动唤醒 Codex 需要另行配置可用的队列桥；默认通过 Skill 等待或读取结果。

当前可用组合：

| 组合                      | Harness                                                                                                                       | 状态                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| DeepSeek-V4.1-Flash + DSH | 模型：DeepSeek-V4.1-Flash；Harness：官方 DSH                                                                                  | 默认对话路径                                      |
| GPT + Codex CLI           | 模型：GPT-6.1 Sol、GPT-6 Astra / Sol / Luna；Harness：本机官方 Codex CLI                                                      | 同一 DSH 会话输入框与消息流转发                   |
| Claude + Claude Code      | 模型：Claude Opus 5.5；Harness：本机官方 Claude Code                                                                          | AWS、Kiro 渠道独立选择，同一 DSH 会话回写         |
| Grok + Grok Build         | 模型：Grok 4.7；Harness：官方 Grok Build，经 ACP                                                                              | 已验证 macOS，同一 DSH 会话回写                   |
| MiniMax + mcode           | 模型：MiniMax-M3.1-Flash-Preview（默认 `max`，档位可选）、MiniMax-M3（默认思考开启，可关闭）；Harness：官方 mcode CLI，经 ACP | 使用官方账号登录，组合 ID 以 `delegate-list` 为准 |

MiniMax 组合使用官方 MiniMax 账号，凭据由官方 `mcode` CLI 自己保存和刷新，不由 OPL Gateway 提供密钥，也不驱动 MiniMax Code 图形界面；只提供 M3.1-Flash-Preview 与 M3 两个组合，分别默认 `max` 与开启思考，用户可按官方能力选择设置。当前仅支持用户明确授权的完整访问；mcode 自身工具不能提供 DSH 的只读或工作区隔离，受限请求在启动前拒绝。安装、登录、权限限制与委派用法见[官方 MiniMax 账号与 mcode](docs/minimax-code.md)。

例如，在 Codex 或 DSH 中说：“让 Grok + Grok Build 在当前项目检查这个模块，把结果返回这里。”派发方会建立关联子对话，继承项目目录，并用指定组合执行；组合详情会显示模型为 Grok 4.7。Grok 对话也能通过内置协作工具把任务交给 DeepSeek + DSH。

“运行配置”设置页负责绑定管理；外部 Harness 的子任务由后台按项目记录工具过程、结果、权限和验收状态。需要继续追问或“交给另一组合”时，在当前 DSH/Codex 对话中使用委派工具。各 Harness 保留自己的上下文、工具和持久会话；交接时提供明确任务说明。

Codex Skill 的 `delegate` 返回组合会话 `id`，用它继续、等待或取消；稳定的 task/operation ID 避免断线重试造成重复执行。从 Codex 派发的外部组合会话绑定一个普通 DSH 会话，其会话 id 只对应官方会话列表中的那一个；委派命令与通知核验仍使用组合 id 和 `execution` 中的 Harness 身份，三类标识不可互换。显式委派任务的完成、失败和观察到的人工等待可共用 DSH taskFeedback 通知发起 Codex 对话；需要启用自动回传及配置真实队列桥，并在升级后用真实外部任务验证主动投递。未配置时，交付仍持久保存，可等待或读取。模型选择器触发的同会话转发直接回到官方消息流，后台记录仍可用于恢复和验收。
通过 Skill 或对话内协作工具按 `claude-opus-5-5` 委派且未指定组合时，默认选 Kiro 分组；指定 AWS 组合 ID 仍可使用 AWS。Kiro 未就绪时不会自动改走 AWS。

组合复用本机安装的官方 Codex CLI、Claude Code、Grok Build 和官方 MiniMax mcode。Harness 页可从常见用户安装目录和登录 Shell 发现 Codex CLI、Claude Code，显示真实路径与版本；已安装时调用官方更新器，缺少程序时提供一键安装并在完成后重新检测。Antigravity 目前支持程序检测与更新管理。Windows 的 Shell 支持按 Harness 区分：Claude/Grok 使用官方接口，MiniMax 使用可回读 Shell 的独立候选版，Codex 官方版本仍为 PowerShell；完整权限与受限任务的行为见 [Windows 本地验证](docs/windows-local-validation.md)。

### 外部 Harness 独立代理

设置 → 运行配置 → Harness 网络代理可分别为 MiniMax Code、Codex CLI、Claude Code、Grok Build 等外部 CLI 选择“继承环境”“直连”或“指定代理”。指定代理填写无账号密码的 HTTP/HTTPS 地址，例如 `http://127.0.0.1:7897`；本地代理程序须已启动。缺省继承 Desktop 的代理环境。直连清除该 CLI 子进程的代理环境变量；CLI 自己另外配置的网络选项仍由其官方实现管理。

代理保存到官方 profile 的组合目录，按 Harness 共用，不更换账号、模型、权限或可执行文件。正在执行的轮次保留原连接，下一轮使用新的 CLI 进程恢复同一会话并应用新设置；已结束的 operation 不重发。指定代理自动绕过 localhost、127.0.0.1 和 ::1，保证本地 ACP/MCP 桥仍可用。此设置作用于外部 CLI 及其子进程，不修改 Desktop 的全局网络，也不控制内置 DSH 模型或单独从终端启动的 CLI。只支持 HTTP/HTTPS 代理，不接收带用户名密码的 URL。

## 自动更新与数据

**官方桌面和 OPL 增强使用一个联合稳定 Release 管理，但更新责任分开。** 官方 DeepSeek Harness 通过自己的更新机制读取 DeepSeek feed，校验 SHA-512、签名和实际版本；OPL 维护入口或协作 Skill 启动时每小时检查一次 GitHub 联合 Release，校验 stable channel、tag、联合清单、资产摘要和逐文件摘要后才安装增强包。运行中的 profile 不替换，网络或校验失败时继续使用已安装版本。设置 → 协作与自动化显示最近一次联合 Release 检查结果。

当前稳定联合版本见[最新 Release](https://github.com/gaofeng21cn/opl-dsh/releases/latest)。官方 DSH 与 OPL 增强的准确版本、平台 feed 和资产摘要以该 Release 的 `release-manifest.json` 为准；官方桌面处于候选阶段时，Release Note 会明确记录候选版本，不会把它改写成正式版。

增强插件、套件缓存和 Skill 位于官方应用外部，官方应用更新不会覆盖这些文件；OPL profile 与官方数据共同位于 `~/.dsh`。界面和安装记录显示实际官方桌面版本；不按版本号人为拒绝新版。插件 API 的实质变化仍可能需要兼容修复。日常使用直接打开官方 DeepSeek Harness。

Homebrew 用户可用 `brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh` 更新到最新联合稳定版；Homebrew 卸载仅移除 OPL 快捷入口，保留官方桌面、用户数据和 Codex Skill。

增强包、更新缓存和安装记录保存在 OPL DSH Suite；官方 profile、登录、会话和设置保存在 `~/.dsh`。重新安装会保留两处已有数据。安装位置与数据兼容细节见[开发与验证说明](docs/development.md)。

新对话显示官方有效默认模型；直接发送也会使用该模型对应的默认 Harness，无需先点选一次。Grok CLI 的 marketplace 初始化标记保留在配置中，后续启动不会把它当作用户修改；其他配置改动仍受保护。

详见[首次启动与登录](docs/first-run.md)、[官方 MiniMax 账号与 mcode](docs/minimax-code.md)、[开发与验证说明](docs/development.md)和[发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)。

## 关于

本仓库是 One Person Lab 独立维护的增强套件，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库仅维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。

### 项目内协作

在官方 DSH 对话中直接提出“请另一模型完成这个子任务”，当前运行配置可委派已就绪的 DSH、Codex CLI、Claude Code 或 Grok Build 配置。子任务继承项目与权限边界，保留精确模型和渠道。发起对话可等待、查询、取消、核验交付和要求继续修改；这些状态由后台记录，主界面保持官方会话 UI。

“协作与自动化”可设置交付后自动回传与修改次数上限。相同项目内由 OPL 托管的写任务排队，只读任务可并行；这不锁定项目外部编辑器或独立启动的进程。中断任务保留原记录，不自动重发。

外部 Codex Skill 仍可自动启动桌面并派发任务，与内部协作共用任务记录；可单独关闭外部接入。外部 Codex 可使用通知或等待和读取取得交付，主动唤醒取决于增强包的组合反馈支持与通知桥配置。通知先领取、独立核验，再登记任务验收并消费；消费通知不等于验收通过。官方 Harness 各自负责 Agent 循环、工具和沙箱，OPL 负责会话关联与交付验收。

## 开发维护

套件采用一个仓库、一个增强包，内部按 Gateway、执行、协作、首启和兼容层划分 Host、Client 与契约。前后端 RPC 由官方 Typert 从服务源码生成，构建验证接口漂移、依赖边界和官方桌面兼容性。代码职责、运行数据和恢复路径见[开发与验证](docs/development.md)，平台资格入口见[兼容验证](docs/compatibility.md)。

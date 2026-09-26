# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

OPL DSH 提供 OPL Gateway 登录、模型双通道、搜索、Codex 协作和模型 + Harness 执行组合。桌面、Agent 循环、工具执行及权限管理均由官方 DSH 或所选官方 Harness 提供；增强功能以独立插件维护。

## 下载安装

### Homebrew（macOS · Apple Silicon）

```sh
brew tap gaofeng21cn/opl-dsh https://github.com/gaofeng21cn/opl-dsh.git
brew install --cask gaofeng21cn/opl-dsh/opl-dsh
```

安装完成后直接打开 `~/Applications/DeepSeek Harness.app`。官方桌面会从默认 `~/.dsh` profile 加载 OPL 增强；`OPL DSH.app` 仅作为维护兼容入口保留。

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

| 系统 | 下载 |
| --- | --- |
| macOS · Apple Silicon | [Mac 一键安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg) |
| Windows · x64 | [Windows 一键安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) |

1. 下载并打开对应平台的一键安装器。
2. 安装器读取 DeepSeek 官方桌面更新清单，下载并验证当前官方桌面，再安装增强插件和 Codex Skill。首次安装需要联网。
3. 在应用内选择 **OPL Gateway**、**DeepSeek 官方**，或 **稍后登录**。

以后直接从 Mac「应用程序」或 Windows「开始菜单」打开官方 **DeepSeek Harness**。无需先安装 Node.js、OPL App 或 OPL Framework，也无需手动填写 Gateway 模型地址和密钥。

这是在线安装器：内含 OPL 增强，安装时自动下载约 300 MB 的官方桌面。Mac 打开 DMG 中的安装应用；Windows 直接运行 EXE。OPL 安装器未签名，首次需按系统提示允许打开；下载的官方桌面会校验 SHA-512 和 DeepSeek 发布者签名。

## 增强能力

- **OPL Gateway**：应用内登录，统一管理账户、余额、连接状态和三组分组密钥。默认模型 ID 为 `deepseek-flash`，在官方模型选择器中显示为 **DeepSeek-V4.1-Flash + DSH**。
- **双通道与故障切换**：自动管理 DeepSeek、Codex 两组模型密钥，并为 Grok Build 管理独立的 Grok 分组密钥。默认通过官方 DeepSeek adapter 使用 Messages；备用通过官方 `dsh-llm-pi-ai` 协议库使用 OpenAI 兼容接口，仍由 DSH 执行工具和管理会话。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，可启动 DSH、连续派发任务、等待结果、读取持久化反馈。设置中可修复 Skill、调整自动启动和可选通知桥。
- **模型 + Harness 组合**：在任意 DSH 或 Codex 对话中可把一个明确任务交给 `Grok + Grok Build`。DSH 提供 `delegate_to_harness` 工具，Codex Skill 提供 `delegate` 命令；两者都会在同一项目目录创建独立的官方 Grok Build ACP 会话，保留 Grok 自己的工具、上下文和会话恢复，再把结果返回当前对话。登录 OPL Gateway 后自动维护 DeepSeek、Codex、Grok 三个分组的独立密钥，Grok 进程通过环境变量引用该密钥。
- **网页搜索**：登录 OPL Gateway 后，DSH 原生 `web_search` 使用 OPL 的搜索路由；`web_fetch` 继续使用官方公共 HTTP 提供方。搜索固定使用低成本的 `gpt-6-luna`，无需额外配置；不提供独立搜索设置页或本地统计。
- **简化首启**：统一账户选择，支持稍后登录；完成后不再重复提示，不导入其他 OPL 应用的登录状态。

设置页按四层管理：**连接与账号**保存 OPL Gateway、DeepSeek 官方或自定义兼容接口；**模型**记录模型 ID 和显示名；**Harness**显示已安装的 DSH、Grok Build 及其适配器；**模型与组合**把模型、Harness、连接和权限绑定成一个实际调用单位。模型选择器按连接来源分组，OPL Gateway 的 OpenAI 备用协议不会再作为第二个重复模型组出现。默认组合为 DeepSeek + DSH，也可以修改显示名、默认项、连接来源和工作区权限；新增的模型只有在存在匹配 Harness 适配器时才会显示为可运行。

Codex 协作保留 DSH 的权限与问题确认。后台主动唤醒 Codex 需要另行配置可用的队列桥；默认通过 Skill 等待或读取结果。

当前可用组合：

| 组合 | Harness | 状态 |
| --- | --- | --- |
| DeepSeek + DSH | 模型：DeepSeek-V4.1-Flash；Harness：官方 DSH | 默认对话路径 |
| Grok + Grok Build | 模型：Grok 4.7；Harness：官方 Grok Build，经 ACP | 已验证 macOS；可从 DSH 工具或 Codex Skill 委派 |

例如，在 Codex 或 DSH 中说：“让 Grok + Grok Build 在当前项目检查这个模块，把结果返回这里。”派发方会建立关联子对话，继承项目目录，并用指定组合执行；组合详情会显示模型为 Grok 4.7。Grok 对话也能通过内置协作工具把任务交给 DeepSeek + DSH。

“模型与组合”设置页负责目录管理；外部 Harness 的子对话在组合工作区按项目查看工具过程和结果，继续追问或“交给另一组合”。Grok 的操作授权在组合工作区确认，DSH 授权仍在原生对话确认。各 Harness 保留自己的上下文、工具和持久会话；交接时提供明确任务说明。

Codex Skill 的 `delegate` 返回组合会话 `id`，用它继续、等待或取消；稳定的 task/operation ID 避免断线重试造成重复执行。当前组合结果通过等待或读取返回，尚未接入原生 DSH 的通知 outbox；外部对话显示在 OPL 组合面板，不会自动创建 Codex 原生侧栏任务。

Grok 组合目前复用本机已安装的官方 Grok Build CLI（默认 `~/.grok/bin/grok`），缺少时显示“未就绪”；按需安装 CLI、Windows Grok 和 Claude 组合尚未提供。

## 自动更新与数据

**产品版本以实际官方桌面版本为准，OPL 修订号仅用于内部更新。** 官方桌面和 OPL 增强分别更新。安装时不固定某个官方桌面版本，而是读取 DeepSeek 官方桌面更新清单。官方桌面直接使用 `~/.dsh`，因此官方应用更新不会丢失 OPL profile；Codex Skill 和维护入口在启动前检查增强更新，每小时最多检查一次。更新会验证下载内容，并保留登录、会话、设置和协作配置。运行中的插件不会被替换，网络或校验失败时继续使用已安装版本。

增强插件、套件缓存和 Skill 位于官方应用外部，官方应用更新不会覆盖这些文件；OPL profile 与官方数据共同位于 `~/.dsh`。界面和安装记录显示实际官方桌面版本；不按版本号人为拒绝新版。插件 API 的实质变化仍可能需要兼容修复。日常使用直接打开官方 DeepSeek Harness，兼容入口只用于维护和增强更新。

Homebrew 用户可用 `brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh` 更新安装器；应用日常更新仍走上述官方桌面与增强各自的更新机制。Homebrew 卸载仅移除 OPL 快捷入口，保留官方桌面、用户数据和 Codex Skill。

增强包、更新缓存和安装记录保存在 OPL DSH Suite；官方 profile、登录、会话和设置保存在 `~/.dsh`。重新安装会保留两处已有数据。安装位置与数据兼容细节见[开发与验证说明](docs/development.md)。

详见[首次启动与登录](docs/first-run.md)、[开发与验证说明](docs/development.md)和[发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)。

## 关于

本仓库是 One Person Lab 独立维护的增强套件，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库仅维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。

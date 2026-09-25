# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

OPL DSH 提供 OPL Gateway 登录、模型双通道、搜索、Codex 协作和模型 + Harness 执行组合。桌面、Agent 循环、工具执行及权限管理均由官方 DSH 或所选官方 Harness 提供；增强功能以独立插件维护。

## 下载安装

### Homebrew（macOS · Apple Silicon）

```sh
brew tap gaofeng21cn/opl-dsh https://github.com/gaofeng21cn/opl-dsh.git
brew install --cask gaofeng21cn/opl-dsh/opl-dsh
```

安装完成后打开 `~/Applications/OPL DSH.app`。Homebrew 会自动下载官方桌面、安装增强并配置 Codex Skill，无需额外运行安装脚本。

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

以后从 Mac 用户「应用程序」文件夹或 Windows「开始菜单」打开 **OPL DSH**。无需先安装 Node.js、OPL App 或 OPL Framework，也无需手动填写 Gateway 模型地址和密钥。

这是在线安装器：内含 OPL 增强，安装时自动下载约 300 MB 的官方桌面。Mac 打开 DMG 中的安装应用；Windows 直接运行 EXE。OPL 安装器未签名，首次需按系统提示允许打开；下载的官方桌面会校验 SHA-512 和 DeepSeek 发布者签名。

## 增强能力

- **OPL Gateway**：应用内登录，统一查看账户、余额和连接状态。默认模型 ID 为 `deepseek-flash`，显示 **DeepSeek-V4.1-Flash**。
- **双通道与故障切换**：自动管理 DeepSeek、Codex 两组模型密钥，并为 Grok Build 管理独立的 Grok 分组密钥。默认通过官方 DeepSeek adapter 使用 Messages；备用通过官方 `dsh-llm-pi-ai` 协议库使用 OpenAI 兼容接口，仍由 DSH 执行工具和管理会话。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，可启动 DSH、连续派发任务、等待结果、读取持久化反馈。设置中可修复 Skill、调整自动启动和可选通知桥。
- **模型 + Harness 组合**：在任意 DSH 或 Codex 对话中可把一个明确任务交给 `grok-build/grok-4.7`。DSH 提供 `delegate_to_harness` 工具，Codex Skill 提供 `delegate` 命令；两者都会在同一项目目录创建独立的官方 Grok Build ACP 会话，保留 Grok 自己的工具、上下文和会话恢复，再把结果返回当前对话。登录 OPL Gateway 后自动维护 DeepSeek、Codex、Grok 三个分组的独立密钥，Grok 进程通过环境变量引用该密钥。
- **网页搜索**：登录 OPL Gateway 后，DSH 原生 `web_search` 使用 OPL 的搜索路由；`web_fetch` 继续使用官方公共 HTTP 提供方。搜索固定使用低成本的 `gpt-6-luna`，无需额外配置；不提供独立搜索设置页或本地统计。
- **简化首启**：统一账户选择，支持稍后登录；完成后不再重复提示，不导入其他 OPL 应用的登录状态。

Codex 协作保留 DSH 的权限与问题确认。后台主动唤醒 Codex 需要另行配置可用的队列桥；默认通过 Skill 等待或读取结果。

当前可用组合：

| 组合 | Harness | 状态 |
| --- | --- | --- |
| DeepSeek-V4.1-Flash · DSH | 官方 DeepSeek Harness | 默认对话路径 |
| Grok 4.7 · Grok Build | 官方 Grok Build，经 ACP | 已验证 macOS；可从 DSH 工具或 Codex Skill 委派 |

向 Grok 委派任务时，Skill 会要求绝对工作目录和明确提示词；同一组合会话可用返回的 `sessionId` 继续、查看或取消。切换组合是一次显式交接，各 Harness 的内部上下文不会伪装成同一份模型会话。

## 自动更新与数据

**产品版本以实际官方桌面版本为准，OPL 修订号仅用于内部更新。** 官方桌面和 OPL 增强分别更新。安装时不固定某个官方桌面版本，而是读取 DeepSeek 官方桌面更新清单。官方桌面保留官方更新入口；通过 OPL DSH 快捷入口启动时，会在打开桌面前检查增强更新，每小时最多检查一次。更新会验证下载内容，并保留登录、会话、设置和协作配置。运行中的插件不会被替换，网络或校验失败时继续使用已安装版本。

增强插件、数据和 Skill 位于官方应用外部，官方应用更新不会覆盖这些文件。界面和安装记录显示实际官方桌面版本；不按版本号人为拒绝新版；若首启衔接接口缺失，会保留官方欢迎窗口。插件 API 的实质变化仍可能需要兼容修复。请保留 **OPL DSH** 启动入口，直接打开官方应用不会自动选择 OPL 的独立数据目录。

Homebrew 用户可用 `brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh` 更新安装器；应用日常更新仍走上述官方桌面与增强各自的更新机制。Homebrew 卸载仅移除 OPL 快捷入口，保留官方桌面、用户数据和 Codex Skill。

数据保存在独立的 OPL DSH Suite 目录中，重新安装会保留已有登录、会话和设置。安装位置与数据兼容细节见[开发与验证说明](docs/development.md)。

详见[首次启动与登录](docs/first-run.md)、[开发与验证说明](docs/development.md)和[发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)。

## 关于

本仓库是 One Person Lab 独立维护的增强套件，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库仅维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。

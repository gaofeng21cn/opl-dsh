# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

OPL DSH 提供 OPL Gateway 登录、模型双通道、搜索和 Codex 协作。桌面、Agent 循环、工具执行及权限管理均由官方 DSH 提供；增强功能以独立插件维护。

## 下载安装

| 系统 | 下载 |
| --- | --- |
| macOS · Apple Silicon | [Mac 一键安装包](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Setup-mac-arm64.zip) |
| Windows · x64 | [Windows 一键安装包](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Setup-windows-x64.zip) |

1. 下载并解压，双击 **安装 OPL DSH**。
2. 安装器自动下载、验证官方桌面，并安装增强插件和 Codex Skill。首次安装需要联网。
3. 在应用内选择 **OPL Gateway**、**DeepSeek 官方**，或 **稍后登录**。

以后从 Mac 用户「应用程序」文件夹或 Windows「开始菜单」打开 **OPL DSH**。无需先安装 Node.js、OPL App 或 OPL Framework，也无需手动填写 Gateway 模型地址和密钥。

首次运行脚本可能需要按系统提示允许打开。官方桌面保留其原始签名；OPL 提供安装脚本和本机生成的启动快捷入口。

## 增强能力

- **OPL Gateway**：应用内登录，统一查看账户、余额和连接状态。默认模型 ID 为 `deepseek-flash`，显示 **DeepSeek-V4.1-Flash**。
- **双通道与故障切换**：自动管理 DeepSeek、Codex 两组密钥。默认通过官方 DeepSeek adapter 使用 Messages；备用通过官方 `dsh-llm-pi-ai` 协议库使用 OpenAI 兼容接口，仍由 DSH 执行工具和管理会话。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，可启动 DSH、连续派发任务、等待结果、读取持久化反馈。设置中可修复 Skill、调整自动启动和可选通知桥。
- **搜索**：支持 Gateway 云端搜索及本地搜索配置。
- **简化首启**：统一账户选择，支持稍后登录；完成后不再重复提示，不导入其他 OPL 应用的登录状态。

Codex 协作保留 DSH 的权限与问题确认。后台主动唤醒 Codex 需要另行配置可用的队列桥；默认通过 Skill 等待或读取结果。

## 自动更新与数据

**官方桌面和 OPL 增强分别更新。** 官方桌面保留官方更新入口；通过 OPL DSH 快捷入口启动时，会在打开桌面前检查增强更新，每小时最多检查一次。更新会验证下载内容，并保留登录、会话、设置和协作配置。运行中的插件不会被替换，网络或校验失败时继续使用已安装版本。

增强插件、数据和 Skill 位于官方应用外部，官方应用更新不会覆盖这些文件。当前配套验收的官方桌面为 **0.1.7-rc.2**；未来官方接口变化仍需适配，不能保证未经验证的大版本更新兼容全部增强功能。请保留 **OPL DSH** 启动入口，直接打开官方应用不会自动选择 OPL 的独立数据目录。

首次安装可导入旧公开版 OPL DSH 的会话、设置和本产品凭据，原目录完整保留。已验证旧版 V3 会话可在官方桌面打开。未公开开发版 V5 会话不会被自动逆转换；若检测到这种格式，会保留原会话及关联存储并提示，其他账户配置仍可导入。

详见[首次启动与登录](docs/first-run.md)、[开发与验证说明](docs/development.md)和[发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)。

## 关于

本仓库是 One Person Lab 独立维护的增强套件，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库仅维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。旧版源码与发布记录保存在 [opl-dsh-legacy](https://github.com/gaofeng21cn/opl-dsh-legacy)。

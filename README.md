# OPL DSH

**OPL DSH 是 One Person Lab（OPL）为官方 DeepSeek Harness 提供的增强套件。** 在 DSH 桌面登录 OPL Gateway，就能使用账户有权访问的模型。套件可以独立安装，也可以接入你已在 OPL 中使用的领域智能体。

- **在 DSH 里用模型对应的官方执行引擎。** 例如，选择 GPT + Codex CLI，在 DSH 对话里让 Codex CLI 读取项目文件、运行测试。模型来自你的 Gateway 分组，工具由本机的 CLI 执行。[配置第一个模型组合](docs/model-harness-guide.md)
- **从 Codex 把任务交给 DSH。** 在 Codex 聊天里交代任务，让 DSH 使用指定的模型组合执行。完成通知会回到原聊天，Codex 可以核对工具输出，再继续下一步。[一键配置与派发示例](docs/codex-task-delegation.md)

## 下载安装

[下载 Windows x64 安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) · [下载 Apple Silicon Mac 安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg)

<details>
<summary>其他安装方式</summary>

<br>

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

通过 Homebrew 安装后，可运行 `brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh` 更新。

<a id="linux-本地迁移"></a>

**Linux x64 安装（官方 DSH CLI/Web）**

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

</details>

### 桌面版首次使用

1. **安装并打开 DeepSeek Harness。** Windows 和 Mac 安装器会下载并校验官方桌面，再装入 OPL 插件和 Codex Skill，无需预装 Git、Node.js 或其他 OPL 应用。升级已有安装时先退出 DSH。安装器未签名，首次运行可能需要按系统提示允许打开。
2. **选择模型来源。** 首次打开时可选 OPL Gateway、DeepSeek 官方或稍后登录。Gateway 用户可在「设置 → 网关账户」查看余额和可用分组，再到「模型供应商 → OPL Gateway → 选择模型」勾选要用的模型。[首次启动与登录](docs/first-run.md)
3. **发出第一条消息。** 如果账号有 DeepSeek 分组，选一个工作区，新建对话，使用 **DeepSeek + DSH** 就能开始，无需另装执行引擎。想用 GPT、Claude 等模型时，再按需安装对应的 CLI。[模型与执行引擎图文指南](docs/model-harness-guide.md)

## 与 One Person Lab 一起使用

One Person Lab 面向论文、基金申请、研究报告等需要多轮审阅和修改的工作。OPL App 是查看工作进度和交付物的工作台。如果习惯在 DSH 对话里工作，可以单独使用 OPL DSH，也可以接入同一套领域智能体。[了解 One Person Lab](https://github.com/gaofeng21cn/one-person-lab/blob/main/README.zh-CN.md) · [OPL App](https://github.com/gaofeng21cn/one-person-lab-app/blob/main/README.zh-CN.md)

例如，已通过 OPL Framework 安装并激活医学研究智能体 MAS 的用户，可以在 DSH 新会话的「Agent 预设」中选中它，让它按自己的专业流程处理任务。领域包由 Framework 管理，只使用模型组合或 Codex 委派无需安装 Framework。[配置领域智能体](docs/cross-harness-team.md#opl-领域智能体预设)

## 更多用法

| 想做什么 | 从这里开始 |
| --- | --- |
| 换模型来源，或确认组合支持哪些权限和输入 | [OFM 免费模型](docs/model-plugins.md) · [MiniMax 官方账号](docs/minimax-code.md) · [各渠道与执行引擎的适配范围](docs/harness-adaptation.md) |
| 给团队成员分配不同引擎，或从仓库接收任务 | [DSH 团队与角色](docs/cross-harness-team.md) · [SuperAgent 仓库协作](docs/superagent.md) |
| 管理长对话上下文 | DSH 引擎默认启用 [Billion Context](https://github.com/ranxianglei/billion-context)。在新会话输入 `/acp` 查看压缩状态。在「插件 → 已安装插件」停用或卸载后重启，可恢复 DSH 自带的压缩。 |
| 在对话中搜索网页 | 登录 OPL Gateway 后，默认通过网关使用 GPT-6.1 Sol 搜索，无需另配搜索密钥。如果已配置 DeepSeek 官方 API Key，可在「设置 → 网页搜索与获取」的「搜索」中选择 **DeepSeek Search API**，直接使用 DeepSeek 官方搜索。 |
| 将任务交给专业应用继续处理 | [Agent 应用交接与 MCP Apps 支持范围](docs/mcp-apps.md) |
| 配置工具审批或桌面操作 | [Auto Review 审批](docs/auto-review.md) · [Computer Use](docs/computer-use.md) |
| 对话与文件 | [不在项目中工作](docs/everyday-guide.md#在项目外聊天) · [编辑消息并重发](docs/everyday-guide.md#修改已经发出的消息) · [打开交付文件](docs/file-deliveries.md) · [将指定会话移到回收站](docs/everyday-guide.md#把指定的-dsh-会话移到回收站) |
| 任务进展与用量 | [设置无进展超时](docs/everyday-guide.md#progress-timeout) · [后台任务通知](docs/desktop-notifications.md) · [选择轮次统计范围](docs/everyday-guide.md#编辑后为什么有两种轮数) · [查看 token 用量和上下文窗口](docs/everyday-guide.md#token-context) |
| 使用习惯 | [记住权限预设](docs/everyday-guide.md#remember-permissions) · [固定 Windows 窗口标题](docs/everyday-guide.md#window-title) · [在 Windows 使用 Git Bash](docs/everyday-guide.md#git-bash) |

## 更新与数据

| 更新对象 | 操作入口 |
| --- | --- |
| 官方 DSH 桌面 | 使用 DeepSeek Harness 自带的更新入口。 |
| OPL 增强层 | 在「通用设置 → 更新」选择更新方式。兼容更新准备好后可点「立即更新」。 |
| 执行引擎 | 在「执行与组合 → 执行引擎与网络代理 → 管理更新」选择引擎并更新。标注「单独管理」的引擎通过原安装渠道更新。[引擎更新指南](docs/model-harness-guide.md#更新引擎) |
| OFM 插件 | 在「OFM 模型服务」使用插件自己的升级入口。 |

重新安装会保留登录、会话和设置。官方桌面的数据位于 `~/.dsh`，增强包及缓存保存在 OPL DSH Suite。[版本与发行说明](https://github.com/gaofeng21cn/opl-dsh/releases/latest) · [数据位置与开发说明](docs/development.md)

## 关于

OPL DSH 由 One Person Lab 独立维护，与 DeepSeek 官方无隶属关系。桌面、会话和权限由官方 DeepSeek Harness 或所选执行引擎提供。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [模型与 Harness 架构](docs/model-harness-architecture.md) · [兼容性验证](docs/compatibility.md)

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。

# OPL DSH · DSH OPL 强化版

基于 **DeepSeek 官方桌面版**的增强套件，提供 OPL Gateway 双通道、Codex 协作和一键安装。桌面程序、Agent 循环、工具执行与会话格式由官方 DSH 提供；本仓库独立维护增强插件和安装体验。

## 安装与使用

当前支持 **Apple Silicon Mac**，已验收官方 **0.1.7-rc.2**。

1. 从 [Releases](https://github.com/gaofeng21cn/opl-dsh/releases) 下载 `OPL-DSH-Setup-0.1.0-mac-arm64.zip` 并解压。
2. 双击文件夹内的 `install.command`。安装器下载并验证 DeepSeek 官方签名的桌面程序，安装 OPL 增强与 Codex Skill；无需自行安装 Node.js、Git 或开发工具。
3. 在自动打开的设置页面登录 OPL Gateway。两组密钥配置完成后，自动打开官方桌面。按桌面提示完成初始设置。

以后从 `~/Applications/OPL DSH.command` 启动，进入带 OPL 增强的官方桌面。再次运行安装器可修复或更新增强；更新前请退出本套件启动的桌面。

安装器按验收版本固定官方包，不静默降级或适配未经验证的新版本。官方应用保留原签名，增强装在应用外部。首次安装需要联网。

## 增强能力

| 能力 | 当前行为 |
| --- | --- |
| Gateway 登录 | 在 DSH 设置中登录 OPL Gateway，自动维护 DeepSeek 与 Codex 两组独立 API key |
| 默认通道 | DeepSeek 分组 → 官方 DeepSeek adapter → Anthropic Messages |
| 备用通道 | Codex 分组 → 官方 `dsh-llm-pi-ai` → OpenAI Responses |
| 故障切换 | 主通道在输出前发生可回退错误时切换备用；取消和已有输出后的错误不会重新执行任务 |
| 模型 | 两条通道均使用 `deepseek-flash`，显示为 **DeepSeek-V4.1-Flash** |
| Codex 协作 | 安装 `opl-dsh-official` Skill；自动启动桌面，派发、续接、等待、读取结果和取消任务 |
| Gateway 搜索 | 在设置中查看并配置 Gateway 提供的搜索能力 |

Pi 在这里提供模型协议适配库，执行任务的 Harness 始终是 DSH。Codex 协作保留官方的权限处理；遇到待批准操作会返回等待状态。当前不支持 DSH 在 Codex 任务停止后主动唤醒 Codex，也未提供 Grok Build 执行组合。

## 数据与安装位置

| 内容 | 默认位置 |
| --- | --- |
| 官方应用 | `~/Applications/DeepSeek Harness.app` |
| 启动入口 | `~/Applications/OPL DSH.command` |
| 插件、安装记录、日志 | `~/Library/Application Support/OPL DSH Suite/` |
| 独立 DSH 数据 | `~/Library/Application Support/OPL DSH Suite/data/` |
| Codex Skill | `$CODEX_HOME/skills/opl-dsh-official`，默认 `~/.codex/skills/opl-dsh-official` |

本套件使用独立数据目录。安装不会迁移或删除旧版 OPL DSH 数据，也不复制旧账户凭据；请在新入口登录。手动修改过的同名 Skill 会被保留，安装器会提示处理，不会覆盖。

卸载时退出本套件桌面，移除启动入口及上述 Skill 即可停用增强。套件数据目录包含会话和凭据，仅在确认不再需要后自行删除。官方应用可继续单独使用。

## 开发与维护

需要 Node.js 24 或更新版本：

```sh
npm ci
npm run typecheck
npm run build
npm test
```

构建产物位于 `dist/OPL DSH 一键安装/`。`npm run package` 生成发布 ZIP。插件只打包 OPL 源码，通过公开 npm 包和官方扩展接口复用 DSH；不打包或修改官方核心。

- `src/gateway/`：账户、双通道、搜索服务。
- `src/client/`：Gateway 设置界面。
- `src/coordination/`：受本机令牌保护的协作入口与等待状态投影。
- `installer/`：官方应用安装、插件安装、启动入口和 Codex Skill。

升级时先选择官方发布版本，更新依赖及安装包校验值，再在官方原包上验收安装、登录、两条模型通道、工具调用和协作链路。维护重点是增强功能与官方接口兼容，不再持续合并上游所有源码提交，也不再发布自制 DSH 桌面 DMG。

旧 fork 源码封存于 [`opl-baseline-20260925`](https://github.com/gaofeng21cn/opl-dsh-legacy/tree/opl-baseline-20260925)。旧桌面壳、V5 会话扩展和配套兼容补丁不属于本套件的维护或迁移范围。旧仓库改名为 `opl-dsh-legacy` 并归档；当前 `opl-dsh` 是独立创建的仓库。

## 来源与许可

官方项目：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。OPL DSH 由 One Person Lab 独立维护，与 DeepSeek 官方无隶属关系。官方程序从 DeepSeek 下载源获取，原签名保持不变。本仓库采用 MIT 许可，来源声明见 [NOTICE](NOTICE)。

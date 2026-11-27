# 官方 DSH 能力复用检查

2026-11-27 对齐与复核：开发依赖与官方桌面发布基线已对齐 `>= 0.2.3-alpha.2`（当官方 `nightly` feed 低于该版本时自动使用已校验 SHA-512 的官方 `0.2.3-alpha.2` 包体，待上游发布更高版本后无缝跟进）。官方 `0.2.3-alpha.2` 的 `@deepseek-ai/dsh-cua-bundle` 已声明 `platforms: ["darwin","win32"]` 并引入 `@deepseek-ai/dsh-cua-windows`：其中 macOS 已随包内置已签名 helper、开箱可用，但官方 `0.2.3-alpha.2` Windows 安装包尚未随包打包 `dsh-cua-windows.exe`（见官方包 README 已知限制）；OPL 安装器与资格门禁已在 `win32` 上校验随包 helper 存在性，待官方 `0.2.3-alpha.3+` / `0.2.3-rc.*` 随包打包后将自动无缝启用。KimiCU 已彻底退役；`vendor/dsh-superagent`、OPL 私有 Auto Review 与三个拆包插件已收归并精简为单一插件 `@one-person-lab/dsh-opl`；`step-code`/`muse-code`/`pool`/`zcode`/`mimo-code` 等私有适配器及长尾消息编辑驱动已退役；`src/updates/` 已移除对官方服务与 Agent 方法的全部 `Object.defineProperty` 运行时劫持。

OPL 先定义用户需要完成的任务，再选择能力负责人。官方已有的能力使用官方插件、公开 API 与持久状态；OPL 只补官方尚未覆盖的部分。官方后续补齐时，在同一升级任务中验证真实调用链、切换调用者并退役重复实现，避免把过渡适配变成永久分叉。

## 官方能力与保留边界

| 用户任务                     | 官方或第三方能力及负责人                                                                                                                     | OPL 的职责与迁回条件                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面启动、更新和插件安装     | 官方桌面、`dsh-app-boot`、`dsh-plugin-manager/operations`、官方 pnpm                                                                         | 安装器调用 `initProfile` 与 `runPluginCommand`，只写套件拥有的文件；`src/updates/` 仅做无侵入只读活动检查、进程退出前 `host-drained.json` 标记与独立更新器握手；官方应用资源与签名保持原样。 |
| 原生对话、模型执行与工具     | 官方 Session、Agent、LLM、工具、沙箱、权限预设与持久投影                                                                                     | OPL 通过公开事件和 Remote 接入账号与外部执行器。冷会话选择读取 `session.projections`，不为读取历史创建 Agent。                                                                       |
| 原生会话读取、队列与等待     | `dsh-api-session-controller` 的 list/search/events/follow/projections、prompt/steer、requestId 去重、队列编辑、fork、state/observeState/wait | OPL 已删除私有等待状态投影，兼容结果读取官方 wait、事件流与历史后映射。idle、输入等待和具体 turn 结束事实分别解释；跨进程反馈只保留自身交付所需的事实。                              |
| 普通 DSH 子任务与团队协作    | `dsh-subagent` 的 local spawn/fork；官方实验 Team 的 lead、具名 teammate、消息、持久 roster 和 task DAG                                      | DSH Agent 新建内部 DSH 子任务使用官方工具；OPL 组合工具只列外部 Harness，并在工具与 service 两层拒绝新建内部目标。旧 OPL DSH 子任务可凭原 sessionId 继续。                           |
| 固定角色、模型与执行器的 Bot | 官方 agent preset、persona、具名 Subagent provider 与工具绑定                                                                                | 复用官方角色、人设、Skills 与配置入口。OPL 只保存预设到执行组合的引用，在公开 agent/created 事件中绑定新会话，不新增 Bot 数据库或修改官方预设包。                                    |
| 一次性外部委派               | 官方 `subagent-codex`、`subagent-claude-code`、`subagent-acp`、`subagent-dsh-sdk`                                                            | 无续作、流式进度和 OPL 交付验收要求时使用官方 provider。需要完整连续对话时仍使用下述协议适配。                                                                                       |
| 外部 Harness 连续对话        | 各官方 CLI/SDK 的 Agent 循环、工具与会话                                                                                                     | OPL 保留连续会话恢复、实时工具/思考流、取消、权限绑定、图片、编辑与真实用量的协议适配（含 `dsh`/`codex`/`claude`/`grok-build`/`antigravity`/`opencode`/`minimax-code`/`kimi-code`/`qwen-code`/`pi`/`kilo`/`vibe` 及用户配置的标准 `custom-*` ACP 引擎）。官方 provider 覆盖这些必要语义后，切换对应适配器。 |
| 模型与 Harness 组合          | 官方模型注册表、模型选择投影、provider 配置；外部 CLI 的执行能力                                                                             | 提供新手零配置默认推荐与聊天框「执行引擎」面板内任意兼容引擎就地切换、一键安装和自定义默认规则，组合仅保存精确引用、权限及默认选择，不复制模型连接。                                |
| 工具自动审批                 | 官方 `dsh-experimental-auto-review` 的原生 `auto` 预设、pre-execute gate、权限与插件生命周期                                                 | 完全由官方插件与官方预设拥有；OPL 已退役私有 reviewer 路由与弹窗。                                                                                                                   |
| 原生 token 与上下文占用      | 官方 token meter、context pressure/breakdown、`TurnUsagePanel`                                                                               | 默认完全使用官方统计。用户选择“当前对话”后，OPL 才按可见历史重新计算 turns/steps；选择“历史累计”时直接使用官方统计。外部 CLI 的实际 usage 和上下文仍由 OPL 适配。 |
| 目标、脚本与项目工作区       | 官方 Goal、Workflow、Workspace、Worktree、Forge                                                                                              | Goal 管同会话目标与预算，Workflow 管前台 agent/pipeline/parallel，Worktree 管隔离分支与目录，Forge 管变更请求与合并。OPL 保留跨 Harness 持久任务和交付验收，但不拥有项目写队列；并发写入遵循[并行写入与工作树](parallel-writes.md)。 |
| Gateway 账号与模型协议       | Gateway 账户 API、官方 `DeepSeekAdapter` 与 `PiAiAdapter`                                                                                    | OPL 仅维护单一 `opl-gateway` 入口、登录、七组权限与模型目录投影；协议转换与分组挂载交由官方 `DeepSeekAdapter` + `mountGatewayPiAiBridge`，零 CSS/DOM 隐藏补丁。                 |
| 免费模型                     | 原版 Our Free Model 的账户、模型、路由、转发与更新                                                                                           | 原样保留第三方插件；OPL 读取公开 owner API，维护已验证组合，不复制账号或路由状态。                                                                                                   |
| 编辑与重发                   | 官方会话分支/日志接口、Native DSH / Codex app-server / Claude SDK 历史分叉与回滚                                                             | OPL 保留已完成历史的停止后编辑，并仅保留原生 DSH、Codex 与 Claude 的停止后编辑驱动（退役长尾 CLI 逆向消息编辑驱动）。                                                                |
| MCP 工具与 MCP Apps          | 官方 MCP Client、Resources、连接和工具执行                                                                                                   | 完全交由官方 MCP 服务负责，OPL 不再维护独立 `src/mcp-apps` 宿主包。                                                                                                                  |
| 设置、Todo 与系统通知        | 官方 Slot、`configForms`、volatile plugin config、设置镜像、会话列表、消息流、todo 投影及状态流                                            | 设置导航收敛为「OPL Gateway」与「执行引擎与协作」两个专属页面；Todo 归官方面板；OPL 保留组合选择、通知偏好与 MiniMax 开关。                                                          |
| Computer Use                 | 官方桌面随附 `@deepseek-ai/dsh-cua-bundle` 原生插件                                                                                          | 完全由官方 `0.2.3-alpha.2+` 原生 CUA 插件拥有，OPL v2 已彻底退役 KimiCU 及其驱动；macOS 已内置签名 helper 开箱可用，Windows 待官方后续随包打包 `dsh-cua-windows.exe`（当前可由用户配置 `helperPath`）后自动启用。 |
| 发布与后续迁回               | 官方桌面 feed、既有每日兼容检查与联合发布流程                                                                                                | 新版检查同时核对本表中的缺口；有替代能力时优先完成同一用户任务的迁移，再验证增强包，不新增一套升级调度器。                                                                           |

## 保留适配的边界说明

官方 Team 目前只接收可继续的本地 spawn/fork provider，不把一次性 Codex、Claude 或 ACP provider 变成可持续 teammate，也不为每次 `spawn_teammate` 提供任意模型/Harness 选择；团队共享工作目录，需要并行修改时使用官方 worktree。OPL 跨引擎团队使用官方 local spawn 承载身份与生命周期，在 `llm/stream` 扩展点转接 Codex/Claude，经每会话 MCP capability 调用官方 `tools.resolve` 与 `tools.execute`，待官方提供完整外部连续成员合同后直接替换。

官方外部 Subagent provider 每次执行新任务并返回最终结果，local spawn/fork 的父子身份、消息与取消归官方 `subagents` 管理，OPL 不再复制原生子任务生命周期。官方 Session Controller 的 `wait` 返回 idle、input-required 或 timeout，具体 turn 成败与审批标识从官方历史和待处理请求读取，不把 idle 自动解释为验收通过。

安装器会在停止的 profile 上移除旧 `@one-person-lab/dsh-execution` / `@one-person-lab/dsh-collaboration` 拆包依赖并一次性将配置合入 `opl-suite`（保留 `cordis.patch.before-v2-merge.yml` 备份）；`installer/profile.cjs` 亦在检测到官方 retired bundles 后迁移旧 Team bundle 引用，不再安装废弃插件。

官方 `ProviderEditor.layoutOf` 仍只识别 DeepSeek 与 pi-ai 布局；OPL Gateway 内部使用官方 `DeepSeekAdapter` 与 `PiAiAdapter`，用户只面对单一 `opl-gateway` 第一公民入口；待官方模型选择身份覆盖 Harness 绑定后迁回组合选择适配。

按最新 Framework v2 与 Studio/DSH 边界（详见 [OPL Flow 控制塔与桌面底部体验约定](opl-flow-workbench-integration.md)）：`opl-dsh` 不承接已退役的 Homebrew Tap 客户端管理、多安装切换、Action Rollback 与 Temporal `provider_*` 面板，也不复制 Studio `opl-host-core` 独占的 `OPL Link companion host` 或 `opl-framework-bridge` 的非微信 `channel_access` 过滤职责；上游保留的 `opl_base` 版本展示与 `source_refresh` 之外，本仓任何外部投影接入均须严格保持只读。

## 迁回要求

升级发现官方提供等价能力时，先验证最小真实路径，再切换唯一写入者与调用者，删除重复服务、配置、UI 和测试。已有用户数据保留必要的单次迁移或只读兼容，不通过自动回退长期运行两套负责人。源码状态不替代类型检查、测试、未修改官方桌面隔离运行或发布证据。

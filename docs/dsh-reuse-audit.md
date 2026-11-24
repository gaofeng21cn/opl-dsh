# 官方 DSH 能力复用检查

2026-11-23 复核官方 `0.2.3-alpha.2`。macOS 和 Windows 安装 feed 均已指向 alpha.2，开发依赖和 SuperAgent 的 DSH peer 与官方 alpha.2 cohort 对齐。模型菜单、工作目录投影和可选 SQLite 会话存储都出现了新的公开接口或持久化路径，不能继续沿用 rc.5 的复用结论。用户安装的实际版本和双平台资格以各自回执为准。

OPL 先定义用户需要完成的任务，再选择能力负责人。官方已有的能力使用官方插件、公开 API 与持久状态；OPL 只补官方尚未覆盖的部分。官方后续补齐时，在同一升级任务中验证真实调用链、切换调用者并退役重复实现，避免把过渡适配变成永久分叉。

## 官方能力与保留边界

| 用户任务                     | 官方或第三方能力及负责人                                                                                                                     | OPL 的职责与迁回条件                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面启动、更新和插件安装     | 官方桌面、`dsh-app-boot`、`dsh-plugin-manager/operations`、官方 pnpm                                                                         | 安装器调用 `initProfile` 与 `runPluginCommand`，只写套件拥有的文件；官方应用资源与签名保持原样。                                                                                     |
| 原生对话、模型执行与工具     | 官方 Session、Agent、LLM、工具、沙箱、权限预设与持久投影                                                                                     | OPL 通过公开事件和 Remote 接入账号与外部执行器。冷会话选择读取 `session.projections`，不为读取历史创建 Agent。                                                                       |
| 原生会话读取、队列与等待     | `dsh-api-session-controller` 的 list/search/events/follow/projections、prompt/steer、requestId 去重、队列编辑、fork、state/observeState/wait | OPL 已删除私有等待状态投影，兼容结果读取官方 wait、事件流与历史后映射。idle、输入等待和具体 turn 结束事实分别解释；跨进程反馈只保留自身交付所需的事实。                              |
| 普通 DSH 子任务与团队协作    | `dsh-subagent` 的 local spawn/fork；官方实验 Team 的 lead、具名 teammate、消息、持久 roster 和 task DAG                                      | DSH Agent 新建内部 DSH 子任务使用官方工具；OPL 组合工具只列外部 Harness，并在工具与 service 两层拒绝新建内部目标。旧 OPL DSH 子任务可凭原 sessionId 继续。                           |
| 固定角色、模型与执行器的 Bot | 官方 agent preset、persona、具名 Subagent provider 与工具绑定                                                                                | 复用官方角色、人设、Skills 与配置入口。OPL 只保存预设到执行组合的引用，在公开 agent/created 事件中绑定新会话，不新增 Bot 数据库或修改官方预设包。                                    |
| 一次性外部委派               | 官方 `subagent-codex`、`subagent-claude-code`、`subagent-acp`、`subagent-dsh-sdk`                                                            | 无续作、流式进度和 OPL 交付验收要求时使用官方 provider。需要完整连续对话时仍使用下述协议适配。                                                                                       |
| 外部 Harness 连续对话        | 各官方 CLI/SDK 的 Agent 循环、工具与会话                                                                                                     | OPL 保留连续会话恢复、实时工具/思考流、取消、权限绑定、图片、编辑与真实用量的协议适配。官方 provider 覆盖这些必要语义后，切换对应适配器。                                            |
| 模型与 Harness 组合          | 官方模型注册表、模型选择投影、provider 配置；外部 CLI 的执行能力                                                                             | OPL 组合只保存精确模型与 Harness 引用、权限及默认选择。官方目前没有可替代全部执行组合的统一绑定与连续会话合同，因此保留组合目录和输入栏选择。                                        |
| 工具自动审批                 | 官方 `dsh-experimental-auto-review` 的原生 `auto` 预设、pre-execute gate、权限与插件生命周期                                                 | 原生 gate、策略和预设已交给官方插件。OPL 仅保留 purpose 路由、预算、原始请求/响应记录和 ZCode 外部审批桥；关闭 OPL reviewer 后，官方继续用当前会话模型审批。                         |
| 原生 token 与上下文占用      | 官方 token meter、context pressure/breakdown、`TurnUsagePanel`                                                                               | 默认完全使用官方统计。用户选择“当前对话”后，OPL 才按可见历史重新计算 turns/steps；选择“历史累计”时直接使用官方统计。外部 CLI 的实际 usage 和上下文仍由 OPL 适配。 |
| 目标、脚本与项目工作区       | 官方 Goal、Workflow、Workspace、Worktree、Forge                                                                                              | Goal 管同会话目标与预算，Workflow 管前台 agent/pipeline/parallel，Worktree 管隔离分支与目录，Forge 管变更请求与合并。OPL 保留跨 Harness 持久任务和交付验收，但不拥有项目写队列；并发写入遵循[并行写入与工作树](parallel-writes.md)。 |
| Gateway 账号与模型协议       | Gateway 账户 API、官方 DeepSeek 与 pi-ai adapter                                                                                             | OPL 维护登录、七组权限与精确路由；协议转换交官方 adapter，组合不复制连接配置。                                                                                                       |
| 免费模型                     | 原版 Our Free Model 的账户、模型、路由、转发与更新                                                                                           | 原样保留第三方插件；OPL 读取公开 owner API，维护已验证组合，不复制账号或路由状态。                                                                                                   |
| 编辑与重发                   | 官方会话分支/日志接口、外部 CLI 的原生分叉能力                                                                                               | OPL 保留已完成历史的停止后编辑与外部 CLI history 适配；官方队列编辑仅针对待处理消息，尚不能替代。                                                                                    |
| MCP 工具与 MCP Apps          | 官方 MCP Client、Resources、连接和工具执行                                                                                                   | 工具连接继续由官方拥有。标准 MCP Apps 能力协商、UI metadata 与同连接 AppBridge 尚缺完整公开合同，OPL 保留必要适配，不另建 MCP 连接。                                                 |
| 设置、Todo 与系统通知        | 官方 Slot、`configForms`、volatile plugin config、设置镜像、会话列表、消息流、todo 投影及状态流                                            | Todo 已完全交还官方面板和投影。OPL 保留组合选择、导航适配与通知偏好。MiniMax opt-out 复用执行插件配置和共享表单，不新增专用读写 RPC。                                |
| Computer Use                 | KimiCU 原始 MCP、官方工具与附件接口                                                                                                          | OPL 只做会话绑定、透传、附件展示、取消和权限门禁。                                                                                                                                   |
| 发布与后续迁回               | 官方桌面 feed、既有每日兼容检查与联合发布流程                                                                                                | 新版检查同时核对本表中的缺口；有替代能力时优先完成同一用户任务的迁移，再验证增强包，不新增一套升级调度器。                                                                           |

## 保留适配的边界说明

官方 Team 目前只接收可继续的本地 spawn/fork provider，不把一次性 Codex、Claude 或 ACP provider 变成可持续 teammate，也不为每次 `spawn_teammate` 提供任意模型/Harness 选择；团队共享工作目录，需要并行修改时使用官方 worktree。OPL 跨引擎团队使用官方 local spawn 承载身份与生命周期，在 `llm/stream` 扩展点转接 Codex/Claude，经每会话 MCP capability 调用官方 `tools.resolve` 与 `tools.execute`，待官方提供完整外部连续成员合同后直接替换。

官方外部 Subagent provider 每次执行新任务并返回最终结果，local spawn/fork 的父子身份、消息与取消归官方 `subagents` 管理，OPL 不再复制原生子任务生命周期。官方 Session Controller 的 `wait` 返回 idle、input-required 或 timeout，具体 turn 成败与审批标识从官方历史和待处理请求读取，不把 idle 自动解释为验收通过。

官方 Auto Review 使用当前会话模型发起 `purpose: 'auto-review'` 的无工具评审。Team 已并入官方基础与 Web 组件且原 `@deepseek-ai/dsh-experimental-agent-team-profile` 已进入 `RETIRED_BUNDLES`，`installer/profile.cjs` 在 profile 停止时调用官方加载器移除已退役 Team 引用，不再安装旧包；安装与迁移**不会自动启用** Auto Review 插件，已有禁用项和官方插件管理器中的选择保持不变，启用 Auto Review 后仍须每个会话显式选择 `auto` 预设。OPL reviewer 适配默认关闭，其面板只管理路线、预算与 ZCode 外部审批桥。

官方 `ProviderEditor.layoutOf` 仍只识别 DeepSeek 与 pi-ai 布局；Bamboo/TypeSafe 的独立决策协议保留现有 namespace 的公开 Schema 扩展、精确 Jev 发现与固定凭据目标，官方开放插件编辑布局后撤去。官方模型选择身份仍只有 provider/model；公开接口覆盖 Harness 绑定后迁回组合选择适配。

## 迁回要求

升级发现官方提供等价能力时，先验证最小真实路径，再切换唯一写入者与调用者，删除重复服务、配置、UI 和测试。已有用户数据保留必要的单次迁移或只读兼容，不通过自动回退长期运行两套负责人。源码状态不替代类型检查、测试、未修改官方桌面隔离运行或发布证据。

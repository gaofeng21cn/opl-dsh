# 模型、Harness 与组合

OPL DSH 在官方桌面上提供账号自动配置、Harness 管理和组合选择。模型配置继续由 DSH 保存，官方 DSH 和外部 Harness 分别执行各自的 Agent 循环。

能力边界按官方 `0.2.3-alpha.2` 公开接口核对，检查日期为 2026-11-23。官方已有能力交给官方插件和持久状态；OPL 只维护当前用户任务仍需要的差额。具体复用情况、迁移范围与后续撤除条件见[官方能力复用检查](dsh-reuse-audit.md)。

## 数据职责

| 对象                | 唯一配置位置                                 | 内容                                                              |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Gateway 账号与分组  | Gateway 账号服务、DSH 凭据服务               | 登录、用量、分组权限、本机激活、各分组 Key、同步错误              |
| 模型                | DSH profile 设置与 LLM 注册表                | 来源、模型 ID、名称、能力、分组路由和协议                         |
| Harness             | OPL Harness 目录                             | 程序身份、可执行文件、适配器；安装路径和版本来自本机检测          |
| 组合                | `execution-catalog.json`                     | `modelRef`、`harnessRef`、`permissionPolicy`、默认与启用状态      |
| 对话                | 官方 Session 或外部 ACP 会话                 | 项目、实际模型与 Harness、权限、历史及协作关联                    |
| 原生子任务与团队    | 官方 Subagent / Team                         | 原生父子身份、local spawn/fork、消息、roster、task DAG 与生命周期 |
| 固定角色与 Bot 声明 | 官方 agent preset / persona / named provider | 角色说明、预设与具名 provider/tool 绑定，不另建 OPL Bot 数据库    |
| 跨 Harness 交付验收 | OPL `harness-sessions/`                      | 跨执行器任务身份、operation、交付、验收与显式重叠的 `writeScope`  |

组合不再保存连接或协议。模型列表是 DSH 注册表的只读投影，不写入组合文件。DSH 原生模型页中的 OPL Gateway 子树通过官方 `settings.mutate` 保存模型：DeepSeek 分组位于 `opl-suite.gateway.models`，其他分组位于官方 `llm-pi-ai` 的对应 Provider profile。编辑和运行读取同一份配置。

## Gateway 分组

账号页管理 DeepSeek、OpenAI 协议、Grok、Gemini、Claude、Kiro、AWS 七种分组的独立凭据。没有某一组的权限不阻止账号登录，也不影响其他已授权组。页面区分未配置、未授权、凭据就绪和同步错误；凭据就绪不等于真实模型调用已经验收。

登录、刷新时按分组尝试获取模型目录。首次导入和未被用户修改的自动目录可以更新；已有用户模型列表保留。模型页也可手动获取候选模型并保存。自动导入失败时保留已有配置。模型目录所有权摘要保存在原生设置中，不另存一份模型表。

目录状态与 Key 状态分开记录；模型页按分组说明缺凭据、认证、网络、超时、设置冲突或服务未就绪，不把全部失败归因于 Key。目录读取使用该组的有效地址、部署前缀与凭据引用，不借用其他分组。Claude/AWS/Kiro 的 Anthropic 默认地址不带 `/v1`，由官方 SDK 追加消息路径；旧套件默认地址和 Claude Opus 5.5、Claude Fable 5.2 缺失的 adaptive 配置会迁移，用户自定义地址、凭据引用和显式兼容设置保持原值。

用户只看到一个 OPL Gateway 来源，账号页控制本机激活分组，模型页获取目录并勾选所需模型。停用分组保留 Key、模型配置和已有对话，但阻止新的调用。新加入的 Kiro 默认未激活；升级保留原分组的激活行为。分组路由显式映射，绝不按模型名字猜测，也不在错误后换组：

| 分组        | 默认执行接口                               | 凭据         |
| ----------- | ------------------------------------------ | ------------ |
| DeepSeek    | 官方 DeepSeek adapter / Messages           | DeepSeek Key |
| OpenAI 协议 | 官方 pi-ai 协议适配库 / OpenAI Responses   | Codex Key    |
| Grok        | OpenAI Responses；Grok Build 通过 ACP 执行 | Grok Key     |
| Gemini      | OpenAI Chat Completions，可在模型页调整    | Gemini Key   |
| Claude      | Anthropic Messages                         | Claude Key   |
| Kiro        | 官方 pi-ai 协议适配库 / Anthropic Messages | Kiro Key     |
| AWS         | Anthropic Messages                         | AWS Key      |

上述协议是套件默认配置，实际服务支持以端点为准。官方 `dsh-llm-pi-ai` 仅转换模型协议，不负责 Agent 循环。

同名模型具有不同身份：DeepSeek 分组保持历史 ID `deepseek-flash`，OpenAI 协议分组使用 `codex::deepseek-flash`。线上请求仍发送 `deepseek-flash`；组合引用同时确定分组，用户不需要输入内部限定 ID。GPT 通过 OpenAI 协议分组直接调用。默认自动目录不会将 DeepSeek Flash 复制到该渠道，用户可在模型页主动加入。

### Messages 断流恢复

原生 OPL Gateway 把 `STREAM_CLOSED` 纳入默认模型请求重试。Messages 流缺少完整的 `message_stop` 时，官方循环保留失败记录，在当前步骤重新请求；不会把未完成的工具参数当作可执行调用，也不会重新发送整段用户任务。

默认使用官方 `normal` 策略：最多额外重试 5 次，沿用官方指数退避和抖动。`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 继续按同一策略处理；重试次数在当前步骤内共享。用户已配置的 `gateway.retryPolicy` 优先，含 `maxRetries: 0` 的禁用策略和自定义错误列表都保持原值。取消会终止重试等待；权限、凭据和无效请求错误不因此被自动重试。

失败响应保存在官方 `assistant/attempt`，重试及实际重新请求分别记录为 `llm/retry`、`llm/retry-started`。此前步骤的成功工具结果仍在会话中，恢复不回退磁盘文件。次数耗尽后保留真实失败，不补造结束事件、不自动切换模型。外部 Harness 的请求恢复仍由各自官方实现处理。`STREAM_CLOSED` 与连接异常 `TRANSPORT`、空闲超时 `TIMEOUT` 分别记录，排查具体截断环节须将失败请求编号与网关、模型上游日志对应。

## 第三方模型插件

OPL 安装器通过官方插件管理器接入 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。首次安装使用固定校验的官方 `v2.8.3` 完整发布包（`installer/model-plugins.cjs`），验证 SHA-256 与 SHA-512 后保存到 profile 的 `vendor/` 目录供安装和后续修复；下载或摘要校验失败即停止，不使用旧版源码包替代。

为兼容官方桌面的路由认证要求，`installer/ofm-desktop-admission.cjs` 在安装或修复时识别 OFM `2.8.3` 与 `2.9.0` 的已知官方文件，只对独立程序目录内的 `index.js` 与 `src/trust.js` 应用[管理接口修正](https://github.com/Ebony-Vinyl/dsh-our-free-model/pull/911)，保留用户已修改文件。如果从 OFM 页面更新后再次遇到管理接口返回 503，可重新运行 OPL 安装器修复已知版本。

OPL 为 OFM 使用 profile 内的独立程序目录，通过官方插件管理器以相对 `link:` 依赖登记。OFM 页面保留原版检查更新、升级与热重载功能；程序文件由 OFM 自行更新，pnpm 只管理链接，OPL 重装保留该目录和已升级版本。插件的数据、账号与路由设置仍由 OFM 在原数据位置管理；停机安装时只迁移确认属于本套件的归档安装，保留用户指定来源、停用状态和宿主管理模式。

OPL 从官方 LLM 注册表读取插件公开的 Provider 和模型，以原始 `provider` 与 `model` 保存组合引用，不复制模型目录或导入密钥。OFM 的 `combo:` 降级与轮换链不作为可执行模型加入对话选择器，外部 Harness 需要绑定已适配的具体模型；OFM 渠道与路由适配规则集中在[外部 Harness 适配](harness-adaptation.md)。第三方模型插件沿用这一条官方注册表与 `ctx.oplExternalModelSources` 显式路由路径，OPL 不另建供应商模型列表或账号池。

## 设置与使用

- **Computer Use** 由桌面随附的官方插件管理权限与原生工具。KimiCU 继续提供已有的 `computer_use` 工具，桌面变更要求会话显式选择“完全访问”。详见[桌面观察与操作](computer-use.md)。
- **推理档位默认值**：DeepSeek 4.1 Flash 的 DeepSeek 与 OpenAI 协议渠道默认推理档位为 `high`；GPT 模型默认 `medium`。MiniMax M3.1 默认 `max`，M3 默认开启思考。默认值仅在未选择档位时使用，同一对话按模型和渠道保存的选择优先，切换模型不沿用其他模型的档位。外部 Harness 在切换组合后自动读取官方能力并显示已确认档位（Antigravity 与 Grok 默认 `high`，不支持档位的组合不显示选项），能力读取不发送模型提示词。
- **OPL Gateway / 模型**：账号页管登录、用量、分组权限与凭据；模型页沿用官方页面并置顶 OPL Gateway，默认平铺模型（高级字段在编辑区展开）。
- **Harness**：检测安装、版本与路径，区分文件存在与版本验证成功，Windows npm 入口选择 `.cmd` 等可执行启动器；ZCode 桌面入口不在检测时启动。内置 DSH 随官方桌面更新，不可删除。执行引擎页常显 DSH、Codex CLI、Claude Code、Grok Build、Antigravity CLI 与 OpenCode，其余已适配引擎收在“更多执行引擎”中；未提供一键安装的引擎保留官方说明与路径登记入口。
- **组合**：从 DSH 模型目录选择模型，绑定 Harness 与权限。每个模型可指定默认组合；没有自定义默认时，GPT 默认 Codex CLI、Claude 默认 Claude Code，Gemini 组默认 Antigravity CLI，其他模型使用已配置的官方默认组合。

对话输入栏复用官方模型目录、模型选择投影、菜单组件与 Slot；OPL 的组合选择菜单显示“模型 · Harness”，来源仅作为展开菜单的分组标题。没有凭据的官方 DeepSeek 模型不作为可选项。DSH 原生组合调用官方 Session 的模型选择接口；外部 Harness 组合绑定到当前官方 Session，由 Host 在 `llm/stream` 阶段转发同一轮请求并把文本流回官方 Session。自动生成组合的权限只作为新委派任务的缺省值，切换模型保留当前会话选择的权限；显式只读组合通过官方只读预设同时设置 sandbox 与审批策略，不会静默扩大当前权限。

厂商官配自动组合来自预先维护的 `OFFICIAL_HARNESSES` 表并在模型就绪后启用；OpenCode、Kilo、Pi 等通用执行器官配列表为空，可在“添加执行组合”中手动选择或从 OFM 推荐添加（跨厂商或通用配对标为“自定义”），经 OFM 本地转发的手动外部组合要求 OFM 本地转发已启用。用户手动停用后，自动投影不会重新打开该组合。

独立配置的原生 Provider 另有 DSH fallback：当官方 `ctx.llm.listProviders()`、`listModels()` 与 `listConfigurableProviders()` 确认 Provider 已进入可配置目录、模型可用且既无官配也无自动外部推荐时，自动生成只读 DSH 组合（OPL Gateway、OFM 和外部 CLI 账号专属来源不适用此 fallback）。已有自定义默认、显式停用与 `defaultDisabled` 选择优先。

MiniMax 官方账号与 mcode ACP 专用集成的开关归唯一偏好 `opl-execution.minimaxCodeEnabled`（默认开启）；停用仅过滤最终实时投影并门禁新轮次/账号操作，保留已有配置、凭据与历史。

每个原生对话选中的组合 ID 保存在 OPL 自有的 `combination-selection.json`，用于重启后区分同一模型的多个自定义组合，冷会话通过公开 `session.projections` 读取。

执行器使用官方 DSH、Grok Build、本机 Codex CLI 的 app-server，以及官方 Claude Agent SDK 驱动的本机 Claude Code，Codex 与 Claude 的配置及会话保存在套件自有目录。OPL Gateway Gemini 默认组合使用 Gemini 4 Carbon 或 Gemini 4 Hydrogen 搭配 Antigravity。两者也可配合 Pi，OpenCode 可手动配对。具体协议和推理边界见[外部 Harness 适配](harness-adaptation.md)。Antigravity 暂仅支持本机管理；Claude Code 的官方 SDK 思考增量独立显示，不显示签名。

图片经官方附件服务接收与读取；外部轮次只持久化附件引用，发送时编码，要求模型来源与 CLI 均声明支持图片（Grok Build `1.0.46` 除外，按已验证版本识别）。各 Harness 协作工具与 Codex Skill 可先查询可用组合再按组合 ID 派发。官方具名 Subagent provider 与 `preset/persona` 适合固定配置的一次性任务，不替代需要连续会话、流式工具或交付验收的组合目录。

## 迁移与验证

旧组合目录首次读取时先保留 `.v1.backup`，再转为模型引用；连接与模型来源冲突时停止迁移并保留文件，不改变官方会话格式。隔离验收方法与验证范围见[官方桌面兼容验证](compatibility.md)。

## 模型与组合的界面规则

模型配置继续写入 DSH 原生设置，页面按模型来源、执行与组合、协作与行为、应用扩展组织：

- 账号页管账号、用量与分组凭据；模型页平铺展示模型并仅以渠道标记区分同名路由，编辑时展开协议和高级字段，不因新增供应商或决策模型复制独立设置页。
- BambooNode StartLux 与 TypeSafe Jev 注册到官方可配置提供商目录，兼容层扩展 `llm-pi-ai` 公开 Schema 并提供固定凭据目标（Windows Keyring）与精确 Jev 发现，卸载恢复原方法。
- 系统通知复用官方通用设置条目，token 用量与上下文占用复用官方统计（旧上下文预算服务与未挂载 UI 已删除）；外部 Harness 网络代理和工具审批折叠区收在“执行与组合”内，不占独立导航。
- 导航名称与顺序集中定义在 `src/shared/client/settings-navigation.ts`，由 `src/compat/client/settings-navigation.ts` 仅在界面层调整公开 Slot 标签与顺序、隐藏导航图标，不改动官方或 OFM 包文件。新增能力与 UI 放置依据见[功能接入与 UI 成本判断](development.md#功能接入与-ui-成本判断)。

## 原生协作与跨 Harness 交付

官方 `dsh-subagent` 与实验 Team 拥有原生本地父子任务、roster 和 task DAG；DSH Agent 发起的新 DSH 内部子任务只走官方工具，OPL 委派工具仅列出并接受外部 Harness 目标（已有 OPL DSH 子任务可凭原 `sessionId` 继续）。角色绑定与领域智能体预设链路见[跨 Harness 团队接入](cross-harness-team.md)。

跨 Harness 连续会话与交付验收由 `HarnessService`（`harness-sessions/`）持久化，Agent 工具注册在 `src/collaboration/host/tools.ts`，外部 Codex 入口位于 `src/collaboration/host/external-codex.ts`。执行态与验收态分离，通知回传经 `taskFeedbackFacts`（v2 投影缓存）与 outbox/receipt 幂等去重，已解决的待审批/提问通知在确认后从投递队列退役并保留审计记录。普通写任务不因共享 cwd 排队；并发 Git 写任务遵循[并行写入与工作树](parallel-writes.md)。

## 审批、计量与 MCP 边界

原生 Auto Review 的权限预设、pre-execute gate 与生命周期由官方 `dsh-experimental-auto-review` 负责，安装器不再自动启用它；OPL 仅保留路由、预算、记录与 ZCode 外部审批桥，详见[Auto Review 工具审批](auto-review.md)。原生计量与编辑统计、MCP Apps 公开接口缺口分别见[日常使用指南](everyday-guide.md)与[MCP Apps 支持范围](mcp-apps.md)。

## 实现边界

Gateway 模型读写由独立 `oplGatewayModels` Remote 负责，不经过首启或 Harness 服务。`oplExecution` 提供执行组合、执行、协作状态及分页读取；账号、首启和 Skill 维护分别挂载。所有 Remote 从同一份服务声明生成 Host 校验和 Client 类型。

会话目录按 ID 分文件保存，原全量文件保留为迁移来源；任务摘要与历史详情分别读取。程序身份、协议桥与环境构造位于各执行器适配模块；主服务管理会话关系、权限和协作规则。具体目录与恢复边界见[开发与验证](development.md)。

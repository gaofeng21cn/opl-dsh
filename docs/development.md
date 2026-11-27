# 开发与验证

OPL DSH 在未修改的官方 DeepSeek Harness 桌面中维护单一功能增强插件 `@one-person-lab/dsh-opl`（Host 与 Client 均装配同一插件配置 `opl-suite`），将 Gateway 账号、执行引擎组合、跨引擎协作、更新检查与桌面通用体验统一打包交付，避免多包拆分状态。

## 功能接入与 UI 成本判断

OPL 的“全插件化”指能力按官方 Host/Client 插件和 Slot 边界组合，状态留在真正的 owner，不等于每项功能都新增安装包或页面，也不意味着新增必要 UI 会被阻断。维护原则是先限定功能真正要解决的用户任务，再判断如何合理纳入；避免照单全收上游能力及其界面，也避免因追求“零增量”而牺牲必要功能。

能力实现位置和 UI 放置是两个独立判断。

**能力实现位置**优先考虑已有 owner，并按实际边界选择：

1. **原样复用**官方 DSH 插件、已安装第三方插件或现有 OPL 模块，保留其原组件、配置、更新和状态负责人。
2. **通过官方扩展点适配**现有插件，优先使用 Host 服务、Remote、Slot、Route、事件或配置接口。
3. **扩展现有 OPL 功能模块**，沿用其 Host、Client、契约和生命周期，补充有界适配器或投影。
4. **新建 OPL 内部功能插件**，适用于确有独立状态、生命周期、失败边界或维护契约的能力；按实际启停边界选择内部模块或独立插件包，统一安装和回滚。

这是复用优先的判断顺序，不是阻断新模块的审批阶梯。最终应选择总维护成本最低、状态 owner 最清楚的方案，而不是为了形式上“复用”把无关能力塞进同一模块。

**UI 放置**应以用户任务、发现路径和信息架构为依据：

- 如果同类任务已有清楚的页面、Slot 或流程，扩展原入口通常更连贯，也更容易保持单一状态和操作 owner。
- 如果功能是高频、核心或需要持续可见的状态与操作，或者放进现有入口会造成职责混杂、重要操作被埋没，新增页面、导航项、弹窗或专用控件是合理方案。
- 上游第三方插件需要保留完整管理能力时，可以保留其原页面或做入口适配；不为“统一”而削减必要功能。
- 新增供应商、模型、Harness、执行程序、审批路线或代码包，本身不足以自动决定要有独立设置页；应根据用户实际需要选择在已有 owner 中扩展、与相近任务合并，或建立新的合适入口。
- 把专属组件移动到已有页面、页尾或弹窗，若没有沿用原来的添加、编辑、删除和状态流程，应视为一次明确的 UI 调整，而不是复用已有交互。

需要避免的是照单全收和无边界扩张：同一状态或配置出现多个可编辑入口、同一操作被不同页面重复提供、每个上游子功能都机械复制成 OPL 导航项，或仅因代码模块和插件边界拆分用户流程。必要的新 UI 不应为了避免这些风险而被无条件拒绝。

每项能力应说明：

- **用户任务**：谁在什么场景需要完成什么，功能是否有必要纳入，以及完成标准；
- **复用候选**：检查过的官方 DSH 插件或扩展点、第三方插件、OPL 模块和 UI 入口，以及采用、适配或拒绝的理由；
- **能力 owner**：Host 服务、官方服务或第三方插件持有状态；Client 只消费投影并发起明确操作；
- **UI 放置**：沿用、扩展现有入口，还是新增页面、导航或交互，以及为什么这个位置最符合用户任务；
- **复杂度净变化**：页面、导航、弹窗、字段、点击次数和重复操作的增减；目标不是机械追求零增量，而是让新增必要性与总体认知成本可解释；
- **维护与回滚**：上游来源、依赖更新责任、禁用或卸载后的清理方式，以及失败时保留和恢复哪些用户数据。

Issue 在实现前记录这些判断，PR 在合并前核对实现与用户目标一致，并补充运行或隔离验收证据。它们是设计审查依据，不是关键词或固定格式的机械否决条件；信息不足时应先补齐可影响结论的事实，新的用户需求也可以据此调整既有信息架构。依赖方向检查负责确定性的模块边界，复用是否合理、新 UI 是否必要和总体复杂度是否变好，仍由维护者结合具体上下文判断。

嵌入官方通用设置的 OPL 条目使用共享偏好行样式：上下留白 16px，标题与说明间距 4px，多控件内容间距 8px。分割线直接位于条目根节点，由官方通用设置统一处理末项；不套用独立设置页的宽度限制或首行特例。

## 模块与依赖

开发与验证使用 TypeScript 7、React 19 和 Zod（具体版本以 `package.json` 与 `package-lock.json` 为准）。TypeScript 7 的 AST 检查通过公开 snapshot API 读取真实源码；测试转译复用构建所用的 esbuild。官方 Typert 生成器继续使用它声明的编译器依赖。Client 产物仍把 React 留给官方加载器；本地 React 19 测试不代表替换了官方桌面的 React。

增强包显式安装自己的 Zod（`package.json` 中声明为 `4.6.7`）。官方桌面的 projection/storage-domain 声明绑定其私有 Zod 版本，运行边界只读取 `parse/safeParse`；`src/compat/host/validation-schema.ts` 在此处保留实际解析结果、转换、默认值和错误，不把 Zod 内部身份交给官方服务（此适配不用于工具 schema、JSON Schema 转换或 schema 组合）。官方桌面资格会回读增强包与官方消费者各自解析的 Zod 路径和版本，并继续校验官方应用未被修改。

官方桌面私有依赖（如内置 Zod、Undici 与 MCP SDK）由官方应用负责解析，profile 依赖或 override 不能替换这些内部导入。OPL 自有 Zod 让已声明的集合上限在元素解析前拒绝超限输入，不为官方无界集合增加上限。官方 HTTP MCP 客户端当前无公开自定义 fetch 或重定向控制入口（跨 origin HTTP 307 会继续携带自定义 header、MCP session ID 与请求 body，仅移除 Authorization）；官方 npm Undici dispatcher 仅在存在代理策略或策略转为 `none` 时接入，公开策略 API 无 TLS/connect 配置入口。上述上游边界须跟随未修改官方新版或新增公开扩展点重新评估。

| 目录                | 职责                                                     | 依赖边界                                                                                |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/suite`         | Host/Client 装配、套件配置、执行生命周期连接             | 组合能力，不保存另一套业务状态                                                          |
| `src/gateway`       | 账号、分组凭据、原生模型配置、路由和搜索，以及对应页面   | 不依赖执行与协作模块；`host/execution-access.ts` 提供 Host 内部的模型读取与执行凭据入口 |
| `src/execution`     | Harness 目录、组合、会话、执行器适配、工作区与选择器     | 使用官方 DSH Session 或外部官方执行器，不实现 Agent 循环                                |
| `src/collaboration` | Agent 协作工具、外部 Codex 接入、Skill 管理和反馈        | 共用执行模块的父子对话与交付记录；旧 TaskFeedback 协议用于兼容原生 dispatch             |
| `src/setup`         | 首启与账号选择                                           | 官方账号与稍后设置不依赖 Gateway 服务挂载                                               |
| `src/updates`       | 正式发布检查、待更新状态与通用设置入口                   | Host 持有检查状态；安装器持有校验、暂存和退出后安装，不更换运行中插件                   |
| `src/compat`        | 必要的官方 UI 结构适配、旧调用入口                       | 新客户端不调用旧接口；模型写操作仍归 Gateway                                            |
| `src/shared`        | 共同使用的模型标识、带类型的 Remote 调用、控制传输及样式 | 不保存业务状态，不提供通用杂物接口                                                      |
| `src/contracts`     | 对外公开的纯类型汇总                                     | 用于生成声明；不引入 Host 实现                                                          |
| `src/generated`     | 官方 Typert 生成的 Host/Remote/声明                      | 只从源代码重建，不手工维护                                                              |
| `installer`         | 安装、迁移、更新、官方校验及 Skill 分发                  | 只操作套件拥有的文件，保留用户修改                                                      |

功能内部使用 `host/`、`client/`、`contracts/`。Gateway 模型页面直接调用 `oplGatewayModels`；执行、首启、安装协作设置分别调用 `oplExecution`、`oplSetup`、`oplCoordination`。账户仍使用 `oplGatewayAccount`。Host 与 Client 分别声明实际依赖，执行和 Skill 设置不以账户服务为共同前提。

`npm run check:boundaries` 检查浏览器不得运行 Host 实现、Gateway 不反向依赖执行/协作、首启不得接管其他能力，以及功能不得依赖套件装配。前端数据请求和异步状态由各能力的 hook 管理，视图负责渲染和明确用户操作。

### 单一插件展示与设置页面收敛

已安装插件使用官方包展示接口：提供中英文名称、说明、离线详情（`docs/plugins/opl-dsh.{zh,en}.md` 由 `build.mjs` 复制入包）、OPL 图标及维护者与项目地址。OPL 不修改官方插件管理器。Our Free Model 保留各自来源和名称。

| 展示名称 | 包与配置 owner | 设置页面布局 | 职责与关闭行为 |
| --- | --- | --- | --- |
| OPL DSH | `@one-person-lab/dsh-opl`；`opl-suite` | 「OPL Gateway」与「执行引擎与协作」两页，及通用设置条目 | Gateway、首启、引擎与组合、跨引擎协作、更新与通用体验；关闭后保留配置与会话，官方及第三方来源继续运行 |

停止状态下，安装器通过官方包管理操作升级或修复单一插件包；升级旧三包（`dsh-execution`/`dsh-collaboration`）时，一次性将旧 `cordis.patch.yml` 中的执行与协作配置字段合入 `opl-suite`（保留目标显式值并保存 `cordis.patch.before-v2-merge.yml`），移除旧包引用后保持组合 ID、官方会话与交付记录位置不变。

官方角色与团队继续拥有唯一的人设、成员、消息、任务板和权限。OPL 保存精确组合引用，并通过公开 `agent/created`、`llm/stream` 与官方工具执行接口转接。具体链路和验证范围见[跨 Harness 团队接入](cross-harness-team.md)。

## 构建与契约

官方升级同时承担能力迁回。先以用户任务判断新版官方 DSH、官方插件和公开接口是否已覆盖 [复用审计](dsh-reuse-audit.md) 中仍由 OPL 保留的差异。已覆盖时，在同次升级中验证最小真实链路，切换唯一调用者，再移除重复实现；只保留无法由官方表达的业务语义。官方 Team、Subagent、preset/persona 与原生权限不建立第二套 OPL 状态。新增 OPL 能力须写明官方缺口、接入位置与迁回条件；不以永久双写或静默回退维持旧路径。

开发使用官方 DSH 支持的 Node.js `^24.22.3` 或 `>=26.13.1`。

```sh
npm ci --ignore-scripts
npm run check:rpc
npm run typecheck
npm run check:boundaries
npm run format:check
npm run build
npm test
```

`src/generated` 不再由 Git 追踪；首次运行或修改 `@Remote` 参数与返回值后，由 `pretypecheck`、`prebuild`、`pretest`（通过 `npm run generate:rpc -- --if-stale`）按需生成，也可显式执行 `npm run generate:rpc`。`npm run check:rpc` 只检查漂移，不改文件。生成器使用安装的官方 `dsh-typert-generator`：在临时目录建立它要求的 workspace 布局，分析真实源代码和原版 protocol 声明，完成后移除临时目录。没有手写平行 Schema 或修改上游生成器。

原生 Client、兼容控制入口和 Skill 调用使用同一个生成契约。Provider 专有模型字段使用可递归的 JSON 类型，经过前后端校验后保留，避免编辑显示名称时丢掉模型能力配置。Host 内部 Remote 调用通过统一兼容入口携带官方 Peer（转发保留调用者身份，后台调用使用随 Context 释放的 owner Peer；旧桌面缺失该工厂时沿用原有内部调用）。

`build.mjs` 先生成契约，再构建 Host、Client 和外部执行器协议桥。官方服务保持 runtime peer；peer 清单来自构建器依赖元数据。Client 样式跟随插件生命周期释放。增强清单记录官方目标版本、内部修订、源提交、dirty 状态、源树摘要及各发布文件摘要，避免将未提交构建误认为纯 HEAD 产物。源树摘要从 Git 已跟踪文件动态取集，排除派生的 Homebrew Cask，包含新增运行文件；本地未跟踪的审看资料不参与产品来源身份。

插件安装使用所选官方桌面 `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`（兼容旧版 `runtime/pnpm/bin` 下的 `pnpm.mjs` 或 `pnpm.cjs`），不借用系统 pnpm；失败证据保留隔离 profile 中最多四份包管理器日志的末尾以便定位入口变化或依赖下载错误。`npm run format` 统一格式（生成文件不经二次格式化）；`npm run package` 创建 DMG/EXE/ZIP 分发产物。

## 执行器与协作

`execution/host/adapters` 中的各执行器各自声明匹配规则和启动方式，外部程序保留自己的上下文、工具与原生会话（Codex 使用 app-server、Claude 使用官方 Agent SDK、Grok 使用 ACP）。Harness 注册表同时搜索桌面 PATH、登录 Shell PATH、常见用户目录和官方应用附带 CLI；Codex CLI 与 Claude Code 的安装/更新只走固定官方入口并重读绝对路径和版本。设置页把 DSH、Codex CLI、Claude Code、Grok Build、Antigravity CLI 与 OpenCode 作为常用引擎直接列出，其余内置及用户添加的自定义标准 ACP 引擎收在“更多执行引擎”与“添加自定义标准 ACP 引擎”中；分类只决定信息层级。

CLI 维护回读绕过版本缓存，并检查安装器返回的实际安装目录；维护命令复用该 Harness 的代理设置。Codex app-server 在启动时和每次创建、加载会话时核验同一个 provider，避免线程参数与全局 Responses 客户端使用不同渠道。已有 CLI 的发现与版本验证不依赖 npm；显式路径保留用户选择。

组合目录只保存模型引用、Harness 引用、默认/启用状态和权限。`ExecutionModelResolver` 从官方模型注册表和 Gateway 读取投影，不另存模型连接。MiniMax 官方 mcode 路线继续由专用 ACP 适配器拥有，它的 opt-out 归 `opl-suite` 的 volatile `minimaxCodeEnabled`（默认 `true`），Client 执行页开关、目录重载和账号 Gate 共用官方 `configForms` snapshot。

DSH 内部新子任务由官方 Subagent/Team 管理。导入外部 Harness 历史后，使用官方 Workspace 的 `attachSession` 登记原会话（`session.create` 仅负责创建或复用空会话）。OPL 协作后台只为跨 Harness 任务保留父子映射、明确任务、验收要求、执行状态、交付和回传状态，并兼容已有 OPL 原生任务。普通会话不因使用同一目录而排队，只读任务可并行；只有双方显式声明且范围重叠的 `writeScope` 才等待，并行 Git 写任务优先使用官方 worktree。取消父任务传递给后代，子任务不能扩大权限。主界面保持官方 DSH 会话 UI，外部 Codex 开关只限制外部桥接，不关闭内部 Codex CLI 组合。

TaskFeedback 的事件投影（`taskFeedbackFacts` 投影缓存版本为 2，含待处理审批 ID 与最后审批事件位置，旧缓存从原始会话日志重投影而不改写日志或 task/outbox/receipt 格式）、纯状态决策、持久回执与投递调度分别位于 `src/collaboration/host/feedback/` 下的 `session-facts.ts`、`state.ts`、`receipts.ts`、`delivery.ts`。尚未送出的审批或问题通知在确认解决后从投递队列退役并保留 outbox 记录，接收方先 `receive` 并在 `review`/`resume` 时核对最新会话再请用户操作。

## 数据位置与恢复

| 内容                     | 权威位置                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 官方模型、登录与原生会话 | `DSH_HOME`，默认 `~/.dsh`；由官方设置、凭据和会话服务负责                                                                |
| 组合配置                 | `profiles/<当前 profile>/execution-catalog.json`；不保存模型连接和密钥。Desktop 为 `desktop`，Linux 默认为 `opl-linux` |
| OPL 会话映射、轮次与交付 | `profiles/<当前 profile>/harness-sessions/`，每个会话一个按 ID 哈希命名的文件                                             |
| 原生对话的组合选择       | `profiles/<当前 profile>/combination-selection.json`                                                                      |
| OPL TaskFeedback 数据    | 官方 Storage Domain 的 `task_feedback` 域                                                                                |
| 套件版本、更新缓存与状态 | 安装回执中的 `suiteRoot`；Mac 默认 `~/Library/Application Support/OPL DSH Suite`，Windows 默认 `%APPDATA%/OPL DSH Suite`，Linux 默认 `~/.local/share/OPL DSH Suite` |
| Codex Skill 与派发账本   | 回执中的 `skillDir`、`ledgerDir`；已有账本路径在修复时保留                                                               |

安装回执明确 `suiteRoot`、`profileHome`、`skillDir`、`ledgerDir`，profile 下的回执用于找到 Suite。自定义 profile 的升级、回滚与启动都显式传递原 profile。

旧 `harness-sessions.json` 首次读取时迁移为按会话文件，完成标记在数据写完后保存；旧文件原样保留。会话列表返回分页摘要，选中会话返回最近轮次；更早轮次按需加载，新 UI 不轮询全量历史。`releases` 保留已安装版本和恢复资料，回执记录 `previousRelease`。

### Windows 桌面独立生命周期

Windows 安装后自动启动与 Codex Skill 自动启动均通过 WMI（`Win32_Process.Create`）创建套件启动器，再经统一 `launch.vbs → setup.mjs` 入口设置 profile 与应用路径，使官方桌面不继承调用方的 Windows Job（关闭 Codex 启动进程不会连带终止桌面）。启动器按安装选择的 Codex home 显式设置 `CODEX_HOME`，且不传递调用方自定义环境块。原生 DSH 网络代理读取系统启动环境或 DSH 主目录 `.env` 中的 `HTTP_PROXY`/`HTTPS_PROXY`（项目 `.env` 不允许设置），执行引擎内的代理只影响对应外部 CLI 及其维护命令。若系统策略禁用 WMI 或启动失败，自动启动明确拒绝且不回退共享 Job，不创建持久服务或计划任务，也不要求提权。

## 更新与发布边界

官方桌面自行更新；OPL 增强层的自动检查、下载校验与退出后一次性后台 watcher 规则，以及 GitHub API 限流降级与联合发布合同，统一归[发布约定](release-policy.md)与[稳定发布 SOP](release-sop.md)。更新准入与排空（`src/updates/`）不通过 `Object.defineProperty` 修改或拦截官方服务或 Agent 实例的方法描述符，而是在应用重启前由只读活动检查与 `host-drained.json` 标记保证安全退出。协议 1 增强包不要求包含本地候选版的 `ofm-upgrade.cjs` 或 `update-errors.mjs`，下载或逐文件摘要校验失败记录为 `verify/integrity`。

Linux CI 执行契约漂移、模块边界、格式、Host/Client 类型、构建与测试（构建必须先于 artifact 测试）。官方桌面资格边界见[官方桌面兼容验证](compatibility.md)。

## Linux CLI/Web 迁移

Linux 使用独立 CLI/Web profile，不加载 Electron 专属 `desktop` profile。默认名称为 `opl-linux`，启动器显式设置 `DSH_PROFILE`、`DSH_PROFILE_DIR` 和 `OPL_PROFILE_NAME`，OPL 状态文件统一由 `src/shared/host/profile-paths.ts` 解析。

```sh
npm ci --ignore-scripts
npm run build
node installer/install-linux.mjs "dist/OPL DSH 一键安装"
"$HOME/.local/share/OPL DSH Suite/launch-opl-linux.sh"
```

安装器复用官方 `runPluginCommand`，安装单一插件 `@one-person-lab/dsh-opl` 与 OFM 的固定版本。Linux 不启用 Desktop 的增强层自动更新。Linux CLI/Web 验收不替代 macOS/Windows 官方桌面资格。

## 本地候选安装

从 PR 分支安装供本机验收的包时，对 `installer/install.mjs` 追加 `--local-candidate`。候选版可检查公开 Release，但不会自动覆盖；用户可以明确准备兼容的新版本，或运行完整安装器替换。安装验收须在完全退出官方应用后，通过当前安装版本所带的更新入口或其兼容维护启动器应用候选，并回读实际组合和安装摘要。

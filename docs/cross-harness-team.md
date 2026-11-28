# 跨 Harness 团队接入

官方角色预设可以绑定精确执行组合，在官方 Subagent/Team 的成员会话中使用 DSH、Codex 或 Claude Code。官方插件和应用资源保持原样。

## 配置与状态职责

官方保存角色、人设、Skills、成员身份、消息、权限与团队任务板。OPL 保存预设到组合的引用以及官方会话到外部会话的关联；组合继续引用模型来源，凭据留在来源服务。已有交付验收记录继续使用原 ID，不复制官方团队状态。

## 启用与使用

本能力由单一增强插件 `@one-person-lab/dsh-opl` 统一提供，角色与团队归官方预设，关闭跨引擎接入后组合执行仍可正常运行。

1. 在官方 Agent 预设中建立开发者、审查者等角色，配置人设、Skills 和所需的官方协作工具。
2. 在「执行引擎与协作」准备已就绪的 Codex、Claude 等精确组合。
3. 在「设置 → 执行引擎与协作 → 跨引擎协作与外部 Codex 委派 → DSH 内协作 → 角色默认组合」分别绑定角色与组合；留空表示跟随会话设置。
4. 使用官方团队入口创建相应预设的成员。绑定作用于新会话和新成员；已有会话继续原组合。组合声明的只读限制可以收紧继承权限，选择组合不会扩大成员权限。

外部 CLI 通过 `opl-harness` MCP 的 `dsh_*` 工具调用官方成员通信和任务能力。角色需要的工具由官方预设控制；OPL 不替角色增加未获准的工具。

## OPL 领域智能体预设

插件优先通过本机 `opld` JSON-RPC（`app.state.get` `fast` 与 `pack.list`）读取 App/Framework 的权威 `agent_packages` 投影（仅在 v1 环境回退 `opl app state --profile fast --json`），只注册同时满足以下条件的标准智能体：已安装、已激活、Codex 可见、依赖就绪、允许启动，并且首页路由可见。MAS、MAG、OBF 等名称来自当前 Package，不在插件中维护固定名单；RCA 等未激活或不可启动的 Package 不会伪装成可用。

此集成使用本机已安装的 OPL Framework `opl` 命令，DSH 安装器不代装 Framework 或领域 Package。启动 DSH 的环境须能通过 `PATH` 找到 `opl`；可以在同一环境运行 `opl daemon status --json` 与 `opl pack list --json`（v1 环境对应 `opl app state --profile fast --json`），确认能返回当前 Package 投影。领域执行所需的 Framework Runway 或领域受管运行前提继续由相应 Package 管理。按最新 Framework v2 与 Studio/DSH 边界（见 [OPL Flow 控制塔与桌面底部体验约定](opl-flow-workbench-integration.md)），DSH 侧保持严格只读，**不**实现 Homebrew Tap 客户端管理、多安装切换、Action Rollback 或任何私有 workflow `provider_*` 面板，也不接管 Studio `opl-host-core` 独占的 `OPL Link companion host`。

未安装 Framework、命令不可调用或投影暂时不可读时，Host 日志会记录预设发现失败，官方角色、普通会话与执行组合仍可使用。首次发现成功前不会添加领域预设；入口恢复后，插件会在下一次定期刷新时重新读取，刷新间隔为 60 秒。Package 的安装、修复与激活继续使用其原生入口。若 Wave 2 简化或移除投影中的多安装字段（如 `installations` / `active_installation_id`），只需确保 `configured_carrier.carrier.observed_sources[].plugin_source_path` 保持输出或同步精简 [domain-agent-presets.ts](../src/collaboration/host/domain-agent-presets.ts) 的只读路径回退，切勿在本仓重新引入多安装切换状态。

1. 新建会话，在官方 Agent 预设菜单选择所需领域智能体。
2. 预设通过官方 `skill-filesystem` 指向该 Package 当前安装来源的主 Skill。人设要求先调用官方 `skill` 工具加载主 Skill，也可以在输入框使用对应的 `/med-autoscience` 等官方 Skill 命令。
3. 在「设置 → 执行引擎与协作 → 跨引擎协作与外部 Codex 委派 → DSH 内协作 → 角色默认组合」为交互会话绑定已就绪的 DSH、Codex 或 Claude 组合。没有可用模型来源或对应 Harness 时，先完成配置；不会自动改用无关模型。正式 StageRun 的 executor 仍由 Package 合同决定，不随交互绑定改变。
4. 开始任务后，仍由 MAS 等领域 Package 的主 Skill 指导后续公开 action、StageRun、产物和专业质量流程。选择预设本身不会创建 StageRun，也不会安装、激活或修改 Package。

领域预设使用官方 persona、文件、Shell、Skill、Office 与压缩，支持会话目标、计划模式、子代理与工作流，并沿用该会话的官方权限。定时任务和 DSH profile 插件管理可从各自的官方入口操作。预设加载失败会保留官方诊断；用户自行编辑的同名预设优先。真实领域结果仍需按对应 Package 的 artifact 和 owner acceptance 验收，预设注册或一次模型回复不等于专业完成。

## 接入链路

官方 local spawn/fork 创建并恢复真实成员会话。OPL 在公开 `agent/created` 事件中选择组合，以 `llm/stream` 转接该成员的执行；官方成员消息进入同一外部会话。人设、团队规则与运行上下文从公开系统提示接口装配。Codex 使用官方 app-server 的 developer instructions，Claude 使用官方 SDK 的 system prompt 扩展。

每个外部会话持有独立 MCP capability，调用者身份由 Host 的会话关联确定。工具列表来自该成员实际获准的工具集合，执行经过官方 `tools.resolve`、`tools.execute` 和权限检查。普通会话标题接口不用于团队成员；成员取消使用官方 Agent 生命周期。

组合、会话和原交付记录沿用原 ID 与数据位置。旧版本拆分插件中的配置字段会在停止状态下一次性迁移合入 `opl-suite`，保留原文件备份。

## 验证边界

源码类型检查、构建、单元测试和模块边界检查覆盖角色绑定、事件装配与生命周期；双平台官方桌面资格由[官方桌面兼容验证](compatibility.md)负责。真实模型混合团队协作与冷恢复仍须按实际目标平台及运行环境单独核对。

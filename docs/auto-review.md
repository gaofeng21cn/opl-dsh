# Auto Review 工具审批

DSH 原生 Auto Review 由官方 `@deepseek-ai/dsh-experimental-auto-review` 插件负责，包括 `auto` 权限选项、工具执行前审查、风险规则、历史绑定和插件生命周期。套件不在安装或迁移时自动启用它；用户通过官方插件管理主动开启，已有开关选择保持不变。每个会话仍须显式选择 Auto，安装和保存设置均不改变已有会话权限。

“执行与组合 → 审查模型路线”是默认关闭的 OPL 适配。它只提供独立 reviewer、请求预算、记录和外部 Harness 审批桥。关闭 OPL 适配后，官方 Auto 继续使用当前会话模型；本开关不启用、停用或卸载官方插件。

## 审查路线

开启 OPL 适配后，DSH 原生和 ZCode 默认使用 OPL Gateway 的专用 `codex-auto-review`，与聊天模型及其推理强度分开。也可以显式选择已注册的无工具 LLM reviewer 或决策模型。原生请求通过官方公开 `llm/stream` 的 `auto-review` 用途接入；OPL 保留官方生成的策略和逐条消息，只适配模型与预算，最终输出由官方插件解析并决定原生工具是否执行。

除通用 LLM reviewer 外，下拉列表还提供 StartLux 与 Jev 三条专用无工具决策模型路线（均见下节[StartLux 与 Jev 决策模型](#startlux-与-jev-决策模型)）。

升级已有 profile 时，套件通过官方设置接口补入缺失的隐藏审查 provider，保留已有聊天 provider、模型列表与审查 provider。配置冲突保留原配置。开启 OPL 适配后，选定路线缺失、请求失败、超时、结果不完整或记录失败均使该次审查失败，不临时切换模型。其他原生执行检查仍生效。

## StartLux 与 Jev 决策模型

### BambooNode StartLux

在 **设置 → 模型供应商 → 添加模型提供商** 中选择 **BambooNode · StartLux**，填写 Bamboo API Key 后保存。Key 只写入 Windows Credential Manager 的固定目标 `OPLDSH:BambooStartLux:ApiKey`，不会写入 `.credentials.yaml`、`.env`、日志或对话记录（不支持 Windows Keyring 的平台不提供个人密钥存储；系统 Keyring 用于避免明文落盘，不能阻止同用户下已运行的恶意程序调用系统凭据 API）。

StartLux 只作为工具审批的无工具审查路线，不作为普通聊天模型显示在执行模型列表中。它使用 Bamboo 的同步 `/v1/decisions` JSON 接口，将当前审查策略和冻结事实转换成一个联合选择题；不提供 DSH 工具调用或执行会话绑定。返回缺失、未知、无把握、超时、HTTP 错误或结果无法保存时均拒绝放行。保存 Key 只证明凭据已写入系统 Keyring，不代表网络连通已通过；验收仅使用合成案例，不发送私人会话、源码或凭据。

### OpenCode Jev（免费）

在 **设置 → 执行与组合 → 审查模型路线** 中启用 OPL 路线适配，选择 **决策模型 → OpenCode · Jev / Jev 1.13 Free**，保存后用于选择 Auto 权限的 DSH 或 ZCode 会话（现有路线和会话权限不自动切换）。

该路线调用 OpenCode 官方公布的 `https://opencode.ai/inference/systemone/v1/systemone`（模型 `jev-1.13-free`），无需个人 API Key；不提供聊天、工具执行或推理档位接口，不进入普通聊天或独立 reviewer 列表，OFM 同名聊天条目也不能作为审查路线。它直接使用 System One 协议，不经过 OFM 转发，也不使用 OpenCode CLI。接口依据：[OpenCode Jev 文档](https://opencode.ai/v2/docs/console/models/#jev)、[TypeSafe Choice 响应](https://docs.typesafe.ai/primitives/choice)。

适配器严格校验模型标识、选择类型、全部选项概率、概率总和与最大项；允许结论要求所选项概率与置信度均至少为 `0.9`。不确定选择、低置信度、字段缺失、矛盾结果、HTTP 错误和取消均不放行。限流或调整开放范围时不借用其他账号、伪造客户端身份、重发动作或改用其他模型；持久授权、新鲜度、超时、下游检查和审核记录仍由 Auto Review 负责。默认测试使用本地固定响应；设置 `OPL_JEV_LIVE=1` 后可单独运行 `tests/auto-review/jev-live.spec.ts`，以合成文本验证接口连通性。

### TypeSafe Jev（个人 API）

在 **设置 → 模型供应商** 添加 **TypeSafe · Jev** 并保存自己的 API Key，然后在审查模型路线的“决策模型”下拉列表选择 **TypeSafe · Jev / Jev 1.13 · 个人 API**。密钥仅保存在 Windows Credential Manager 的 `OPLDSH:TypeSafeJev:ApiKey`（不支持 Windows Keyring 的平台不提供）；未配置或无法读取密钥时不展示此路线。

个人路线固定调用 `https://api.typesafe.ai/v1/systemone`（稳定版本 `jev-1.13.0`），按个人 TypeSafe 账户额度使用，与 OpenCode 免费路线分开。删除密钥后路线立即撤下，在途请求发送前仍重读密钥；不会自动切换免费接口、环境变量或明文凭据，已发出的请求不能通过删除本地密钥撤回。接口依据：[TypeSafe System One](https://docs.typesafe.ai/api/system-one)、[官方模型列表](https://docs.typesafe.ai/models)。

## 外部 Harness

ZCode 的 Auto 新对话使用官方 `build` 模式。OPL 对原生会话、精确调用 ID、ACP 会话、连接代次、轮次、结构化工具参数和持久用户指令做绑定，通过独立 reviewer 回答外部权限询问，保存结果后再次核对。绑定不完整时保留人工审批，已认领审核失败则拒绝。官方 Auto 插件没有外部权限请求的公开 classifier，因此这部分仍由 OPL 实现。

Codex 与 Claude 使用各自官方审核接口，不经过此审查模型。未经验证的其他 Harness Auto 模式拒绝启动，其已有普通权限流程保留。外部对话创建时保存审核模式；改变模式后须新建对话，恢复不改变原权限。

## 设置与记录

开关、路线和预算点击保存才生效。过期 revision、在途审查或任一项目活动任务会使修改被拒绝。保存回执丢失时先重新读取，不重发结果不确定的保存。空闲 Auto 会话不阻止关闭 OPL 路线适配。

关闭或卸载 OPL 适配不修改会话权限，官方 Auto 的启停与卸载行为由官方插件负责。官方当前版本从运行中的应用移除 Auto 插件时，会将存活 Auto 会话迁移到 Full access；应用正常关闭则保留 Auto，恢复时需要该官方插件。管理权限应以官方界面显示和实际会话读回为准。

记录保存在当前 profile 的官方 `opl_auto_review` storage-domain。原生记录只保留官方请求、实际 reviewer 路线与原始响应，供核对，不声明工具已获准或已执行。外部审批记录另含其真实调用身份、绑定事实与桥接结果。旧记录保持可读，不重放历史工具或历史审查。

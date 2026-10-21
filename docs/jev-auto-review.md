# Jev Auto Review 决策模型

在 **设置 → 执行与组合 → 工具审批** 中选择 **决策模型 → OpenCode · Jev / Jev 1.13 Free**，保存后用于选择 Auto 权限的 DSH 或 ZCode 会话。现有审查路线不会自动切换，保存也不改变会话权限。

这条路线使用 OpenCode 官方公布的 `https://opencode.ai/inference/systemone/v1/systemone`，模型为 `jev-1.13-free`，免费入口无需个人 API Key。Jev 接收冻结的审查策略、授权历史及待执行动作，返回固定选项、概率和置信度。它没有聊天、工具执行或推理档位接口，因而不出现在普通聊天或独立 reviewer 列表中。OFM 的同名聊天条目也不能作为审查路线。

适配器检查模型标识、选择类型、全部选项的概率、概率总和和最大项；允许结论还要求所选项概率与置信度都至少为 0.9。不确定选择、低置信度、字段缺失、矛盾结果、HTTP 错误和取消均不放行。已有的持久授权、新鲜度、超时、下游检查与审核记录仍由 Auto Review 负责。置信度阈值不能代替这些检查，也不代表已证明误放行率。

免费服务可能限流或调整开放范围；审核失败时不会借用其它账号、伪造客户端身份、重发动作或改用其他模型。此路线直接使用 System One 协议，不要求 OFM 实现该协议，也不使用 OpenCode CLI 来执行审核工具。

默认测试使用本地固定响应验证解析与失败路径。设置 `OPL_JEV_LIVE=1` 后可单独运行 `tests/auto-review/jev-live.spec.ts`，用合成的本地读取、精确授权删除、未授权删除、敏感外传及不可信授权内容验证真实接口；只向模型描述动作，不执行这些动作。少量合成案例是接入验证，不是完整的安全效果评测。

接口依据：[OpenCode Jev 文档](https://opencode.ai/v2/docs/console/models/#jev)、[TypeSafe Choice 响应](https://docs.typesafe.ai/primitives/choice)。

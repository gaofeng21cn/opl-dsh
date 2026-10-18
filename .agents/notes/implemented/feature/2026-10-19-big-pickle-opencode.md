# Agent Note: Big Pickle 的官方 OpenCode 适配

Status: implemented

## Problem

OFM 2.5.2 的实时公开目录已把 `big-pickle` 标为 `availability: "available"`、route `our-free-model`。官方 OpenCode/Zen 目录也提供 `big-pickle`，走 OpenAI-compatible Chat Completions，这是该模型所属/首选 Harness 路线。此前的调查把它当作 OFM 未发布或不可用的目录-only 条目，写在 `OFM_OPENCODE_DIRECTORY_ONLY_MODELS` 中并拒绝启动；这一结论已经过时。

旧的持久化组合目录还可能保留自动生成的
`auto:["our-free-model","big-pickle"]` DSH 组合。它会让刷新后的模型继续绑定 DSH，并阻止为同一模型生成 OpenCode 组合。

## Decision

把 `big-pickle` 作为精确的 `our-free-model` 车道加入 OpenCode 的模型声明、`opencode/<id>` 映射和 pinned Harness 表；wire 值为 `opencode/big-pickle`，模型 ID 和来源归属都不改写。

- 从 `OFM_OPENCODE_DIRECTORY_ONLY_MODELS` 移除 `big-pickle`，只保留 `exo-free` 和 `ll-alpha-free`。
- 自动组合由 `defaultHarness` 决定，因此 Big Pickle 的默认 Harness 是 `opencode`，不会生成 Big Pickle + DSH。
- `ExecutionModelResolver` 在投影前识别以 `auto:` 开头、属于 OFM 且 Harness 与当前默认 Harness 不一致的持久化行，调用 `cleanLegacyCombinations` 删除并落盘，然后重新生成 OpenCode 自动组合。用户自定义组合使用自己的 ID，不在删除范围内；其他 OFM 模型和非 OFM 来源不受影响。
- OpenCode 适配器声明 `reasoning: 'none'`。官方 OpenCode 只广告 `model` 和 `mode`，没有推理档位；OFM 的 light/balanced/deep token budget 不能变成可选的 `high`/`max`。显式传入任何档位仍在启动前拒绝。

## Alternatives considered

**保留 Big Pickle + DSH 自动组合，只新增 OpenCode 组合。** 放弃，因为同一模型会出现两个默认组合；旧 DSH 行还会阻止 OpenCode 自动组合生成。

**按模型 ID 删除所有 Big Pickle 组合。** 放弃，因为会删除用户自己创建的非 generated 组合，违反保留用户配置的边界。

**把 OFM 的 token budget 映射为 OpenCode 推理档位。** 放弃，因为官方适配器不广告该选项，映射只能靠猜测，且会虚构 `high`/`max` 这类上游未声明的档位。

## Consequences

Big Pickle 与其他官方 OpenCode 免费车道走同一套 ACP 启动、模型 pin 和回读路径，没有第二套 Agent loop、自建端点或额外凭据读取。旧自动 DSH 行在首次刷新时被清理并持久化，之后只保留 OpenCode 组合。目录声明仍不等于真实调用成功；本次没有联网调用模型。

验证覆盖映射、适配器声明、pinned 来源、默认 Harness、旧 generated DSH 组合迁移、未知/不可用条目拒绝和推理档位不虚构。未验证的上游限制记录在
`repair-20261019/big-pickle-opencode/report.md`。

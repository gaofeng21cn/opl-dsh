# Agent Note: OFM OpenCode 免费模型路由

Status: implemented

## Problem

OFM 目录新增了 Beam、Nemotron 3.5 Super VL 和 GLM 5.3 Flash，但目录还包含没有对应 OFM 所有权或不能形成可验证组合的条目。

## Decision

将 Beam Free、Nemotron 3.5 Super VL Free 和 GLM 5.3 Flash Free 作为 `our-free-model` 的 OpenCode 内置免费通道，分别映射到精确的 `opencode/<model>` 值。`exo-free` 和 `ll-alpha-free` 仅存在于 OpenCode 目录时保持拒绝，不猜测 provider、端点或凭据。目录刷新不会覆盖该所有权判断。

后续变更（2026-10-19）：OFM 2.5.2 的实时目录开始把 `big-pickle` 发布为 `availability: "available"` 的 `our-free-model` 车道，因此它已从目录-only 拒绝列表移出，改为精确的 `opencode/big-pickle` 组合。详见 [Big Pickle 的官方 OpenCode 适配](2026-10-19-big-pickle-opencode.md)。本笔记原来对 `big-pickle` 的拒绝结论自此失效。

## Alternatives considered

**把目录中的所有免费 id 都映射到 OpenCode。** 放弃，因为目录条目只证明 wire id，不证明 OFM 发布了对应模型，也不证明 DSH 能获得可用的端点或凭据。

**把新模型并入已有的 qualified Nemotron 路由。** 放弃，因为 bare free id 与 `nvidia/...:free` 是不同的 provider/model 组合，静默替换会改变用户选择和来源生命周期。

## Consequences

新模型会随 OFM 来源进入 OpenCode 组合；目录-only 条目继续从实时组合中拒绝，并保留明确的测试覆盖。该适配记录了目录和来源的匹配关系，但不把目录声明当作联网调用成功证据。

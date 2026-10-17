# Agent Note: Kilo Beam 与 Xing4.0 路由

Status: implemented

## Problem

OFM 的 Kilo 清单新增了 Beam 1.0 和 Xing4.0，但 DSH 的 Kilo 配对表仍只声明旧的免费模型，因此这些由 OFM 所有的精确路由会继续落回原生 DSH 或无法建立 Kilo 组合。

## Decision

将 `reflection/beam-free` 和 `xingchen-agi/xing4.0-29b-a4b:free` 作为 Kilo 的精确 `our-free-model` 组合。两个模型使用现有 Kilo ACP 的 Chat Completions 配置和 `oplkilo/<id>` pin 机制，保持斜杠、冒号和来源所有权，不猜测底层模型或替换为同名路由。

## Alternatives considered

**继续使用原生 DSH。** 放弃，因为 OFM 已为这两个条目提供 Kilo 车道，继续使用 DSH 会绕过已验证的 Kilo 路由并产生错误的 Harness 归属。

**把两个模型改写成 OpenCode 或 Kilo 的其他模型 ID。** 放弃，因为 provider/model ID 是来源所有权和请求目标的一部分；官方 Kilo ACP 已广告并回读这两个精确值，改写会掩盖漂移。

## Consequences

Kilo 组合会在实时 OFM 目录发布对应条目时出现，并在启动前要求官方 CLI 广告和回读相同的精确 ID。适配复用了现有 Chat、Git Bash、来源租约和失败关闭逻辑；Kilo CLI 未广告的推理档位仍不会被伪造。

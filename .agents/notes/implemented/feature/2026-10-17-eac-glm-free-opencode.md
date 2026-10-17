# Agent Note: EAC GLM Flash Free 的 OpenCode 绑定

Status: implemented

## Problem

OFM 在 EAC 车道发布 `opencode/glm-5.3-flash-free`，原有适配只识别不带前缀的 `glm-5.3-flash-free`，因此新条目被分配给 DSH。

## Decision

将 EAC 的精确模型 ID 加入 OpenCode 适配器和 OFM 配对表。它继续使用 OFM owner 提供的转发端点，CLI 选择值为 `oplopencode/opencode/glm-5.3-flash-free`，请求模型 ID 保留 `opencode/` 前缀。

## Alternatives considered

不去掉前缀映射到 OpenCode 内置免费模型，因为那会绕过 EAC，改变用户选择的渠道。不按名称统一匹配所有 GLM，已有 `z-ai/glm-5.3-flash` 仍由 ZCode 执行。

## Consequences

组合列表为 EAC 条目选择 OpenCode，保留 OFM 来源归属。来源目录撤销、转发未开启或 CLI 不广告该模型时仍拒绝启动；本地绑定和官方 CLI 回读测试不代表 EAC 上游始终可用。

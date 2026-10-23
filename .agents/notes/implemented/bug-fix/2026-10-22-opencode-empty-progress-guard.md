# Agent Note: OpenCode 空进展请求收口

Status: implemented

## Problem

An OFM Chat request can receive a non-success response such as 403 or 429. The official
OpenCode CLI may retry that request without emitting an ACP terminal error. DSH then keeps
the external turn running even though no text, thought, tool, or permission event has
arrived.

## Decision

The Chat relay reports upstream non-2xx responses as a synthetic, credential-free ACP
error tied to the pending `session/prompt`, preserving the HTTP status and mapping only
known status families. The first failed response header terminates the turn without
waiting for the body; the bridge stops its relay and CLI, ignores late CLI output,
and reports only one failure. Socket failures carry no invented HTTP status.
执行插件的统一等待预算覆盖首次输出及之后的停滞，见[执行无进展等待](2026-10-23-bounded-execution-waits.md)。适配器的首次进展计时仅用于未配置统一预算的独立调用者。

The guard does not retry requests, reinterpret upstream status codes, or claim that a
provider is available. A provider or CLI error that reaches ACP still uses the existing
structured error mapping.

## Verification

The ACP failure tests cover both a silent prompt and a prompt whose first update removes
the guard. The subprocess tests use a CLI that retries errors and an upstream response
whose body never ends: HTTP 403/429/503 must reach ACP after the first request. Socket
failure must report no HTTP status, and a successful stream must still complete.
Optional official OpenCode 1.19.0 checks verify HTTP 403/429 through the same bridge.

Native OpenCode endpoints bypass the OFM relay. The official stderr stream supplies primary inference failures correlated by ACP session id; title failures and unrelated sessions are excluded. Only fixed diagnostics reach the user. An official CLI loopback regression verifies a direct quota refusal terminates before the no-progress deadline.

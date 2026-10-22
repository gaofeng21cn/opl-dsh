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
OpenCode declares a ninety-second first-progress guard on
`session/prompt` as a fallback. The shared ACP transport starts that guard only for the
adapter that requests it and clears it when the matching session reports an assistant
text chunk, thought chunk, tool update, or permission request. A prompt that reaches one
of those events may continue until the existing ACP request deadline. A prompt that
reports no progress fails with a fixed, credential-free diagnostic and closes the owned
Harness process.

The guard does not retry requests, reinterpret upstream status codes, or claim that a
provider is available. A provider or CLI error that reaches ACP still uses the existing
structured error mapping.

## Verification

The ACP failure tests cover both a silent prompt and a prompt whose first update removes
the guard. The subprocess tests use a CLI that retries errors and an upstream response
whose body never ends: HTTP 403/429/503 must reach ACP after the first request. Socket
failure must report no HTTP status, and a successful stream must still complete.
Optional official OpenCode 1.19.0 checks verify HTTP 403/429 through the same bridge.

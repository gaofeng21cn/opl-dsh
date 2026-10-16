---
title: Route selected OPL Gateway Gemini models through OpenCode
kind: feature
status: implemented
---

OPL Gateway Gemini remains an OpenAI Chat Completions route owned by the Gateway group. The OpenCode pairing accepts only the exact `gemini::gemini-4-argon`, `gemini::gemini-3.8-flash`, and `gemini::gemini-3.1-pro` references, resolves their Gateway credential and endpoint through the existing execution access service, and sends only the unqualified model id inside OpenCode's private provider namespace. Other Gateway models and all unregistered providers keep their existing Harness selection. Availability and launch still fail closed when the Gateway credential, model route, or OpenCode model advertisement is missing.

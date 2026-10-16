---
title: Keep external Harness effort IDs out of native provider selection
kind: feature
status: implemented
---

外部 CLI 的推理档位由 Harness 的 ACP 广告决定，不能写入官方 DSH 模型选择。Host 将选择保存到独立的外部组合记录，并在发送外部轮次时读取；发送前仍以本次 ACP 广告校验精确值。切换模型、会话重载、运行时关闭或持久化状态变化会使正在等待的保存失效，避免把旧档位用于新模型。原生 DSH 模型继续使用官方 `selectModel` 校验。

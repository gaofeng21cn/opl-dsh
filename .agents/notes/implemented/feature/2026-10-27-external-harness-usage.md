---
kind: feature
status: implemented
date: 2026-10-27
---

# 外部 Harness 用量投影

ACP v1 没有标记 `PromptResponse.usage` 是本轮还是会话累计值；两类实现都已存在。OPL 自有桥接器对已验证的官方协议分别输出 `opl/turnUsage`，外部 OpenCode/Kilo 则从同一官方消息图按用户消息父级汇总 `step-finish`。没有明确边界或出现不一致时保持未知，避免把累计值逐轮重复相加。

ACP `usage_update` 的 `used/size` 是当前会话上下文占用和窗口容量。它不被转换为账单 Token，避免把当前上下文大小显示成累计输入用量；Host 会独立把窗口容量记录到 `request/context`，并在重放时保留占用事实。重复的同容量更新不会重复追加容量事件。

没有明确边界的普通 ACP usage 不产生 Token 统计；没有上下文更新的 Harness 也不产生伪造的容量或占用值。Kimi 只有 transcript steps 能拆出独立 cache buckets 时才产生 Token 统计；MiniMax 0.6.3 standalone ACP 只显示上下文占用。

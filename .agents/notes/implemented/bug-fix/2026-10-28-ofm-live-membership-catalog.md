---
title: OFM 缓存目录与实时可用路由分离
kind: bug-fix
status: implemented
---

OFM 的 catalog 可以因为目录刷新失败而保留旧模型；模型选择和自动组合必须同时检查公开 summary 的 membership 路由。membership 缺少模型时，外部 Harness 组合标为当前不可用；成功的实时 membership 快照只移除系统生成的旧组合，用户手动保存的组合保留以便诊断。新模型发现页保留不可用模型并用醒目的状态说明，选择与添加组合过滤不可用保存项；缓存目录不会单独证明模型仍可调用。

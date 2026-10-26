---
title: 华为云 DeepSeek 与 Kimi 执行组合
kind: feature
status: implemented
---

华为云 deepseek-v4-flash 使用官方 DSH pi-ai Chat Completions 适配器；kimi-k2.6 使用官方 Kimi Code 的 openai 路由，OFM Kimi 仍使用 Messages。Kimi 转发只接受固定 Huawei HTTPS 端点及精确模型，按既有协议回读权限与 Git Bash。Key 继续由原凭据服务读取，不持久化到 CLI 配置。目录仅增加实测可调用的两个 ID，不把 403 或未知模型纳入默认组合。原 glm-5.2 路线保留。

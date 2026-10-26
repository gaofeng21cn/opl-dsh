---
title: 华为云 DeepSeek 与 Kimi 执行组合
kind: feature
status: implemented
---

华为云 deepseek-v4-flash 使用官方 DSH pi-ai Chat Completions 适配器；kimi-k2.6 使用官方 Kimi Code 的 openai 路由，OFM Kimi 仍使用 Messages。Kimi 转发只接受固定 Huawei HTTPS 端点及精确模型，按既有协议回读权限与 Git Bash。Key 继续由原凭据服务读取，不持久化到 CLI 配置。目录仅增加实测可调用的两个 ID，不把 403 或未知模型纳入默认组合。原 glm-5.2 路线保留。

华为云 OpenAI 兼容接口声明 V4 Flash 的 reasoning_effort 为 high/max，默认 high；模型解析与实际请求共同使用官方 pi-ai 档位映射，仅广告这两档。K2.6 不提供强度或思考开关，忽略该渠道旧的界面思考选择，保留 CLI 默认模式。其他来源的 Kimi 能力声明不受影响。

GLM-5.2 的 ZCode 桥接提供 high/max 配置项，默认 max。配置项在发送前由 Host 写入并回读，官方 session/send 使用该值；个人 provider 映射同时设置 thinking=true 与 reasoning_effort。旧 enabled 解析为 max；不接受其他未公布选择。

GLM-5.2 的固定档位表可直接提供菜单能力，不启动临时 CLI 获取相同配置；Host 将未选择的默认值回读为 max。外部 CLI 已保存的选择独立于能力预检加载状态显示，避免发送或刷新时伪装成“默认”。官方模型拥有档位的 Codex/Claude/MiniMax 在普通对话发送时保留请求档位，不能按 CLI 独立选择路径一律清空。

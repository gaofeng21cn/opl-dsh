# Agent Note: Auto Review 决策模型选择

Status: implemented

## Decision

工具审批保留在官方“执行与组合”页面。审查路线分为默认 Codex Auto Review、独立 reviewer 和决策模型；决策模型使用单独下拉框，当前只登记 Bamboo StartLux 的精确 provider/model。Host 保存并验证路线类别，不允许通过错误类别调用决策适配器。

StartLux 根据凭据服务报告的 Key 配置状态注册，不依赖尚未保存的供应商表单。凭据删除或存储不可读时撤销路线；晚到的状态读取不能覆盖新状态，插件卸载后不能重新注册。Key 是否被远端接受仍由实际请求确认。

StartLux 不提供用户可选的推理档位，因此不声明 reasoning 字段。官方 LLM 服务将空 efforts 数组判为无效模型信息；回归检查必须通过真实 LlmRuntime 的模型解析和 Auto Review 路线枚举，不能只检查适配器自身的返回值。

# Messages 断流恢复

原生 OPL Gateway 把 `STREAM_CLOSED` 纳入默认模型请求重试。Messages 流缺少完整的 `message_stop` 时，官方循环保留失败记录，在当前步骤重新请求；不会把未完成的工具参数当作可执行调用，也不会重新发送整段用户任务。

默认使用官方 `normal` 策略：最多额外重试 5 次，沿用官方指数退避和抖动。`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 继续按同一策略处理；重试次数在当前步骤内共享。用户已配置的 `gateway.retryPolicy` 优先，含 `maxRetries: 0` 的禁用策略和自定义错误列表都保持原值。取消会终止重试等待；权限、凭据和无效请求错误不因此被自动重试。

失败响应保存在官方 `assistant/attempt`，重试及实际重新请求分别记录为 `llm/retry`、`llm/retry-started`。此前步骤的成功工具结果仍在会话中，恢复不回退磁盘文件。次数耗尽后保留真实失败，不补造结束事件、不自动切换模型。外部 Harness 的请求恢复仍由各自官方实现处理。

这项恢复处理临时断流，不承诺阻止网关或模型服务截断响应。判断具体截断环节需要将失败请求编号与网关、模型上游日志对应；`STREAM_CLOSED` 与连接异常 `TRANSPORT`、空闲超时 `TIMEOUT` 分别记录。

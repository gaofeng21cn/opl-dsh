# BambooNode StartLux Auto Review

在 **设置 → 模型供应商 → 添加模型提供商** 中选择 **BambooNode · StartLux**，填写 Bamboo API Key 后保存。Key 只写入 Windows Credential Manager 的固定目标 `OPLDSH:BambooStartLux:ApiKey`；不会写入 `.credentials.yaml`、`.env`、日志或对话记录。

StartLux 只作为工具审批的无工具审查路线，不作为普通聊天模型显示在执行模型列表中。它使用 Bamboo 的 `/v1/decisions` 请求，将当前审查策略和冻结事实转换成一个联合选择题。返回缺失、未知、无把握、超时、HTTP 错误或结果无法保存时均拒绝放行。

保存 Key 只证明凭据已写入系统 Keyring，不代表 Bamboo 网络请求已通过。真实验收使用合成的低风险允许、明确中风险拒绝和高风险拒绝案例；不会把私人会话、源码或凭据发送给 Bamboo。Bamboo 当前提供的是同步 JSON 决策接口，不提供 DSH 工具调用或执行会话绑定。

Windows Keyring 不会阻止同一 Windows 用户下已经运行的恶意程序调用系统凭据 API；它的作用是避免 API Key 以明文文件形式落盘或进入备份、日志和命令行。

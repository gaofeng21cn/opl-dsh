# 外部 Harness 适配准备

模型来源、执行引擎和组合分别由现有模型供应商、Harness、执行组合入口管理。增加来源不需要增加设置页，也不自动改变现有模型的默认 Harness。

## 显式来源注册

`ctx.oplExternalModelSources.register(ctx, source)` 允许来源插件声明精确的模型与外部 Harness 配对。`source.provider` 使用官方 LLM 注册表的原始 Provider ID；`supports(harness, ref)` 声明配对，`resolve(harness, ref)` 在 Host 返回 `baseURL`、实际 `model`、`apiKey` 和 `protocol`。协议为 `responses`、`messages` 或 `chat`，必须与适配器一致。凭据由来源插件读取，不进入公开模型目录或组合配置。

注册通过来源插件的 effect 管理，卸载后拒绝新的解析；异步解析期间来源被替换或卸载也拒绝启动。OPL Gateway 保持已有配置读取路径。其他来源必须显式注册，不能按模型名称猜账号、拆解虚拟轮换链或复制插件私有设置。

只有声明 `customEndpoint` 的适配器接受新来源。当前 Codex 支持 Responses，Claude 支持 Messages；仅有官方账号或固定端点的 Harness 不因为模型协议相似就接受任意来源。Our Free Model 尚未注册外部执行来源，因此保持原生 DSH 路由。

## 能力与验收

每个适配器声明传输、认证、协议、自定义端点、权限、恢复、取消、推理档位和 Auto Review 类型。公开 Harness 检测结果返回这些声明，不包含密钥。声明描述接入接口，实际服务可用性仍由真实调用验证。

`HarnessAcceptance` 复用真实适配器的新建、恢复、模型与推理档位核对、真实工具事件和取消检查。调用者负责进程生命周期、独立读取产物以及向 `observe` 传入 ACP 通知。文本声称执行成功不通过；恢复必须保留会话身份，取消回执必须等待原 prompt 确认取消。

接入具体来源时依次验证：来源与协议负例、真实登录或 Key、真实模型工具调用、新建与恢复、取消、权限与人工审批、Auto Review、失败与卸载。不同 Harness 的协议适配仍需实现，通用注册和验收步骤不能代替这些证据。

# 华为云 MaaS 模型与执行引擎

华为云 MaaS 使用独立保存的 Key 与 `https://api.modelarts-maas.com/openai/v1`。`deepseek-v4-flash` 使用官方 DSH（Chat Completions），`kimi-k2.6` 使用官方 Kimi Code，已有 `glm-5.2` 继续使用 ZCode。不会借用 OFM 或 OPL Gateway 的线路。模型权限以华为云实际响应为准，未开放的 `glm-5.3`、`deepseek-v4.1-flash` 和未识别的 `deepseek-v4-pro` 不加入此目录。

## 本机配置 Key

在 **设置 → 模型供应商 → 添加模型提供商** 中选择 **华为云 MaaS**，在原生 API 密钥输入框填写 Key 后保存。添加后使用普通提供商行的“编辑”更换 Key，“删除”通过原生确认同时移除该提供商配置及其已保存的可写 Key。密码框始终为空，不会恢复已保存的值。没有华为云独立页面、页尾卡片或额外凭据表单。

Windows 上的 API Key 保存在 Credential Manager，不写入 `.credentials.yaml`、`.env` 或模型设置。升级时会把旧版本明文凭据迁移到固定的 Windows Keyring 目标，并在精确读回成功后删除明文；读回缺失或不一致时保留原件并停止迁移。旧 Windows 条目仍使用相同的固定目标，不会产生第二份副本。首次迁移完成后才开放华为云添加入口，避免后台写入与正在编辑的表单发生版本冲突。迁移完成后，手动删除的提供商不会在重启时自动恢复。

华为云模型与对应自动组合跟随原生提供商配置；删除提供商后停止自动投影和凭据探测。已有用户保存的组合保留为不可用引用。目录读取只检查凭据存在性，API Key 值仅在实际请求中读取。

Windows 使用固定目标 `OPLDSH:HuaweiMaaS:ApiKey`。Keyring 不可用时保存直接失败，不回退到明文文件。macOS 保留官方凭据服务的存储、来源优先级与更新事件，Windows Keyring 代理不会接管它。

Windows 已保存的 Key 优先；没有保存值时继续使用官方服务的启动环境回退。保存和删除只操作系统 Keyring，不把 Key 写回明文文件；删除已保存值后，原有环境来源可以重新生效。

保存 Key 不会测试模型、启动任务或自动重发失败请求。保存成功只说明官方凭据已写入，不代表 ZCode 与 Huawei 模型连接已通过验收。

模型菜单显示已启用的 `GLM-5.2 · ZCode`；Key 或官方运行时未就绪时置灰并显示原因。安装 ZCode 运行时与保存 Key 是两个独立步骤，重复保存 Key 不会安装 CLI。官方 Windows 桌面包包含 `resources/glm/zcode.cjs`，可使用该未修改的官方包中的 `ZCode.exe` 以 Node 模式运行此入口。Harness 配置的 `command` 保存可执行文件绝对路径，`prefix` 保存 bundle 的绝对路径；不能只写未安装到 PATH 的 `zcode`。

## 接入验收状态

接入复用官方设置与凭据接口、原生提供商 UI、官方模型目录与 `GLM-5.2 · ZCode` 组合；模型可用状态同时检查官方凭据服务和官方 CLI。真实 Windows ZCode 包的模型注册、新建、恢复、订阅和关闭已在全新隔离用户目录中验证，本地模拟请求也确认普通 API-key provider 使用配置中的静态鉴权值。模型菜单可用状态只表示本机依赖齐备，不能代替真实 Huawei 模型请求验收。

ZCode 自定义 API-key provider 当前只接受静态字面量 Key，不消费官方账号的请求时鉴权接口。候选接入由 OPL 在固定 Huawei 目标的 loopback 转发中通过现有私有 stdio 通道按请求向 Host 读取绑定的华为凭据并注入鉴权，ZCode 配置只保存非秘密占位值；代理使用 Node 24.5 以上的 `https.Agent({ proxyEnv })`，不会把代理写入 Desktop 全局环境。该转发方案的真实请求、流式响应、取消与重连必须先通过实机验收，不能以配置格式或测试 fixture 通过代替。

ZCode 不是原生 ACP；转换桥复用 OPL 的 ACP 会话传输与反馈。已发布 app-server 的 `model.streaming` 正文与思考增量、`tool.updated` 工具执行及结果投影到普通 DSH 会话，标题更新使用官方 `session.titleUpdated`。组合只接受用户明确授权的完整访问，映射到 ZCode `yolo`；受限任务在启动前拒绝。官方仍要求人工确认的请求在 DSH 会话中处理。`plan` 是工具权限策略，不是操作系统只读沙箱。

恢复会话使用官方默认工具集合并回读原会话权限；不传 `toolAllowlist: ["*"]`，因为该接口按精确工具名称筛选，星号会排除所有内置工具。实机验收须包含跨进程恢复后的真实工具结果，不能只检查新建会话。

首次真实模型验收需要用户先在本机配置 MaaS Key。华为云的端点、模型与区域要求见[快速体验 GLM-5.2 模型](https://support.huaweicloud.com/bestpractice-maas/bestpractice_maas_0013_01.html)。官方 Harness 源码见[ZCode](https://github.com/zai-org/ZCode)。

## 新增模型协议

Kimi Code 使用 Huawei Chat Completions 路线，转发仅接受固定端点、精确模型与 completions 路径，保留上游错误分类；OFM 的 Kimi 仍使用原有 Messages 路线。CLI 通过现有 Git Bash 配置运行，仅使用用户已经授权的权限。DeepSeek 复用官方 pi-ai 消息与工具回放适配器，凭据按请求从现有 keyring 服务获取，思考内容按真实响应显示。DeepSeek V4 Flash 提供 `high`、`max` 两档，默认 `high`，通过 `reasoning_effort` 原值发送；不提供额外思考开关。Kimi K2.6 没有已确认的强度档位，不增加该选项。档位依据[华为云 OpenAI 兼容接口](https://support.huaweicloud.com/model-call-maas/model-call-021.html)，不是照搬 DeepSeek 自家 API 的取值。

# 外部 Harness 适配准备

模型来源、执行引擎和组合分别由现有模型供应商、Harness、执行组合入口管理。增加来源不需要增加设置页，也不自动改变现有模型的默认 Harness。

## 显式来源注册

`ctx.oplExternalModelSources.register(ctx, source)` 允许来源插件声明精确的模型与外部 Harness 配对。`source.provider` 使用官方 LLM 注册表的原始 Provider ID；`supports(harness, ref)` 声明配对，`resolve(harness, ref)` 在 Host 返回 `baseURL`、实际 `model`、`apiKey` 和 `protocol`。协议为 `responses`、`messages` 或 `chat`，必须与适配器一致。凭据由来源插件读取，不进入公开模型目录或组合配置。

注册通过来源插件的 effect 管理，卸载后拒绝新的解析；异步解析期间来源被替换或卸载也拒绝启动。OPL Gateway 保持已有配置读取路径。其他来源必须显式注册，不能按模型名称猜账号、拆解虚拟轮换链或复制插件私有设置。

外部适配器在解析前调用 `lease(harness, ref)`，在最后一次异步启动检查后调用 `assertCurrent()`；即使同一来源对象卸载后再次注册，旧 lease 也失效。lease 只核对注册生命周期与声明配对，实时模型目录和连接数据仍由来源 owner 校验；OPL Gateway 继续使用其原有路径。

只有声明 `customEndpoint` 的适配器接受新来源。Codex 支持 Responses，Claude 支持 Messages；仅有官方账号或固定端点的 Harness 不因为模型协议相似就接受任意来源。

## Our Free Model 组合

套件通过 OFM 的公开 `/clients` 接口读取免费车道的运行端点、Key 与模型目录，并在启动前再次核对官方 LLM 注册表。先在 OFM 的「本地转发」启用免费车道；未启用、模型撤销、来源卸载或准入失败时拒绝启动。账号车道 `our-free-model-region` 不借用免费车道的端点。

| 模型 | 首选 Harness | 协议 |
| --- | --- | --- |
| Kimi K2.6、K3 | Kimi Code | Messages |
| MiMo v2.6 Flash | MiMo Code | Chat |
| Laguna S、XS 2.1 | Poolside | Chat |
| GLM 5.3、5.3 Flash（z-ai 原始 ID） | ZCode | Chat |
| EAC GLM 5.3 Flash Free（opencode/glm-5.3-flash-free） | OpenCode，经 OFM 转发 | Chat |
| GPT-OSS 20B | Codex CLI | Responses |
| Step 5 Preview，两条独立车道 | StepCode | Chat |
| Ling、LongCat、North Mini Code、Nemotron 3.5、Space Bunny、OpenRouter Free | OpenCode | Chat |
| OPL Gateway Gemini 4 Argon、Gemini 3.8 Flash、Gemini 3.1 Pro | OpenCode | Chat |
| Nemotron Nano Omni、LFM、Inkling Small | Pi Coding Agent | Chat |
| Dots、Glyph、Kilo Auto Free | Kilo Code | Chat |

这些组合保留 OFM 的原始模型 ID，只有当前目录仍提供的模型才可启动。Free/Auto 虚拟路由保留其虚拟身份，不声称已固定到某个底层模型。程序仍在「执行引擎」选择安装路径，凭据仍由 OFM 管理。MiMo Code 没有推理档位接口，模型菜单不显示其 provider 的原生档位；托管任务保留提交时的设置，不继承原生请求自动填入的档位。CLI 内部带 provider 前缀的模型 ID 由适配器显式映射，仍与回读值严格比对。新适配器支持明确选择的完全访问，缺少 Git Bash 时拒绝启动；不自动改变会话权限。Kimi 另可映射官方 Plan 模式，实测 Bash 写入被工具层拒绝，这不代表操作系统隔离。其余新适配器拒绝只读和工作区权限。它们不提供 DSH Auto Review。

Muse Code 1.4.7-R6101.1 使用独占设置中的 `endpoint_transport` 接入模型供应商的 Responses 端点。MSP 桥接负责会话、模型和思考档位回读，Git Bash 通过官方 MCP 工具接口执行；本机认证转发器转换工具命名与流事件，不替换官方执行循环。来源未提供端点或凭据、模型已移除或协议不匹配时拒绝启动。MiMo Code、Pi 和 StepCode 返回空正文且没有成功工具结果时，任务标为失败；官方未回报的上游错误不推测为某个 HTTP 状态。

独占官方 CLI 与受控 provider 检查覆盖工具、模型回读、恢复、取消和 Git Bash；这些检查不等同于 OFM 联网模型质量验收。执行插件配置 `ofmConnectionTimeoutMs` 控制公开连接读取超时，默认 10000 毫秒。

外部程序的过滤环境保留 Git 安装根目录与显式 `OPL_GIT_BASH_PATH`，即使 Desktop 的 PATH 不含 Git 也能解析后端。显式路径无效时拒绝启动，不改用其他 Shell。

## 能力与验收

每个适配器声明传输、认证、协议、自定义端点、权限、恢复、取消、推理档位和 Auto Review 类型。公开 Harness 检测结果返回这些声明，不包含密钥。声明描述接入接口，实际服务可用性仍由真实调用验证。

`HarnessAcceptance` 复用真实适配器的新建、恢复、模型与推理档位核对、真实工具事件和取消检查。调用者负责进程生命周期、独立读取产物以及向 `observe` 传入 ACP 通知。文本声称执行成功不通过；恢复必须保留会话身份，取消回执必须等待原 prompt 确认取消。

接入具体来源时依次验证：来源与协议负例、真实登录或 Key、真实模型工具调用、新建与恢复、取消、权限与人工审批、Auto Review、失败与卸载。不同 Harness 的协议适配仍需实现，通用注册和验收步骤不能代替这些证据。

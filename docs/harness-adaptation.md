# 外部 Harness 适配准备

模型来源由现有模型供应商及「OPL Gateway」入口管理；执行程序检测、组合绑定、网络代理与跨引擎协作统一位于「执行引擎与协作」页。增加来源不需要增加设置页，也不自动改变现有模型的默认 Harness。

## 显式来源注册

`ctx.oplExternalModelSources.register(ctx, source)` 允许来源插件声明精确的模型与外部 Harness 配对。`source.provider` 使用官方 LLM 注册表的原始 Provider ID；`supports(harness, ref)` 声明配对，`resolve(harness, ref)` 在 Host 返回 `baseURL`、实际 `model`、`apiKey` 和 `protocol`（`responses`、`messages` 或 `chat`，必须与适配器一致）。凭据由来源插件读取，不进入公开模型目录或组合配置。

注册通过来源插件的 effect 管理，外部适配器在解析前调用 `lease(harness, ref)`，并在最后一次异步启动检查后调用 `assertCurrent()`；卸载或替换即拒绝启动，但 `lease` 不代替实时目录校验。只有声明 `customEndpoint` 的适配器接受新来源（Codex 支持 Responses，Claude 支持 Messages）；仅有固定端点的 Harness 不因协议相似而接受任意来源。OPL Gateway 保持已有路径。

## Our Free Model 与渠道适配

默认仅生成厂商官配（DeepSeek → DSH、GPT → Codex CLI、Claude → Claude Code、Gemini → Antigravity CLI、Grok → Grok Build）。OpenCode、Pi、Kilo 的已适配渠道及用户添加的自定义标准 ACP 引擎（`custom-*` 或声明 `adapter: "acp-custom"`）既可在聊天框「执行引擎」就地切换，也可在“自定义默认规则与快捷预设 → 启用与添加组合”中设为默认；不可用组合不进入对话选择列表。`combo:` 虚拟轮换链不加入对话选择器，`step-5-preview-free`、`muse-spark-1.2-contributor-free` 当前从选择器隐藏，`jev-1.13-free` 与 `nvidia/nemotron-3.5-content-safety:free` 明确排除。

- **来源标签与状态**：“OFM 新模型发现”只展示来源当前目录中的模型，不补入已下架条目；发现与已启用列表共用“目录已移除”“未启用”“状态未确认”“不可用”标签（读取失败标记状态未确认，不认定下架）。普通保存保留隐藏配置，“取消全选”或按 Harness 取消同步停用对应隐藏组合；单独“移除”仅停用配置，不删除历史会话。
- **免费车道与账号车道**：套件通过 OFM 的公开 `/clients` 接口读取免费车道运行端点、Key 与目录并在启动前复核官方注册表，须先在 OFM「本地转发」启用免费车道；账号车道 `our-free-model-region`（保留 `region-limited` 标识）不借用免费车道端点。OpenCode 官方免费通道保留独立来源名称。
- **同名模型与前缀规则**：同名路线按精确完整 ID（如 `opencode/`、`amd/`、`z-ai/`、`:free` vs 裸 ID）与所属渠道分开配置和转发，绝不互相合并或替换。旧 Space Bunny 会话保留原模型身份。

| 模型或渠道家族 | 首选 / 适配 Harness | 协议与关键适配边界 |
| --- | --- | --- |
| Kimi K2.6、K3、K3.1 Pro（K3.1 Pro 须开启思考） | Kimi Code | Messages；`KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=1` 避免叠加重试，另可映射 Plan 模式 |
| EAC DeepSeek V4.1 / V4 Flash（`deepseek-ai/deepseek-v4.1-flash`、`amd/DeepSeek-*`） | DSH | Chat / 原生模型服务；DSH 菜单 light/balanced/deep 控制输出预算 |
| Mistral Large 4（`mistralai/mistral-large-4-1t-a52b`） | Mistral Vibe 3.0.4 | Chat；独立 `VIBE_HOME`，需手填 `vibe-acp` 路径，仅支持完全访问、无推理档位 |
| `amd/Qwen3.8-27B` | Pi（默认推荐）/ Qwen Code 0.27.3（可选） | Chat；Qwen Code 仅支持文本输入与完全访问，Windows 需 Git Bash |
| EAC OpenCode 免费车道（`opencode/*`）、`big-pickle`、OpenCode 裸 ID 免费模型、OPL Gateway Chat 通道 | OpenCode | Chat；`opencode/big-pickle` 等裸 ID 走官方免费通道并启用 `--print-logs`（捕获 `AI_APICallError`），亦可在聊天框就地用于 OPL Gateway DeepSeek/Grok/Gemini 备选运行 |
| Kilo 频道模型（Ling 3.1/3.2 Flash、ERNIE-5.5-Flash-Preview、Particle-1、Apodex 1.1 Mini、LFM3-1.7B、Inkling 2 Small、Nemotron 3 Super、Flint v1.0、Beam、Dots、Glyph 等） | Kilo Code | Chat；Kilo ACP 无可写 effort 选项，保持来源默认设置不显示推理菜单（`liquid/lfm-3-1.7b:free` 显式档位请求发送前拒绝）；Kilo Beam 透传 `interleaved` `reasoning_content` |
| EAC Pi 车道（Nemotron 3.5 Lightning/Bolt/Super VL、Nemotron 3 Ultra、Nano Omni、Muse Glimmer 30B、AMD MiniCPM/Gemma 4/Qwen3.8、Gemma 4 31B、Inkling/LFM2.5） | Pi Coding Agent | Chat；通过 `--mode rpc` 桥接，Windows 经 `--append-system-prompt` 提示 Git Bash 语法 |
| GPT-OSS 20B（`openai/gpt-oss-20b`） | Codex CLI | Responses |
| 用户添加的自定义标准 ACP 引擎 | 用户指定二进制与启动参数 | 显式声明 `custom-*` 或 `adapter: "acp-custom"`；仅支持由外部 CLI 自主管理权限的 `full-access`；不覆盖官方自动默认推荐 |

### Gateway Gemini 路线边界

- **现行模型集合**：`GATEWAY_ANTIGRAVITY_GEMINI_MODELS` 包含 `gemini-4-carbon`、`gemini-4-hydrogen`、`gemini-4-argon` 和 `gemini-3.8-flash`（`gemini-3.1-pro` 已从现行集合退役，仅保留旧配置迁移识别）。
- **Antigravity CLI（默认官配）**：使用 Gateway 原生 Gemini 端点与该组凭据，无需 Google 账号登录；新建与恢复固定模型及推理档位（Carbon/Argon/3.8 Flash 支持 `low`/`medium`/`high`，Hydrogen 另支持 `xhigh`，未指定时默认 `high`）。支持来源声明的图片输入；Windows 通过独占 profile Hook 使用 Git Bash；仅支持完全访问；仅支持首条消息编辑重开。
- **OpenCode / Pi（可选备选）**：OpenCode 适配以上全部四项 Gateway Gemini 模型作为备选组合（中途编辑可选 OpenCode）；Pi 适配 `gemini-4-carbon` 与 `gemini-4-hydrogen`（文本输入与完全访问）。Antigravity 失败不自动转发到 OpenCode；自定义 Chat 地址不推断原生 Gemini 地址。

### 渠道错误、编辑与计量边界

- **Kimi Code 渠道错误与编辑**：Kimi Code ACP 可能将非认证类渠道失败返回为 `end_turn`。OPL 为每个 Kimi 进程提供独立本机 Messages 转发观察错误，将上游停用模型、缺失路由、限额和超时显示为固定诊断（不回显原始正文/账号/凭据，也不重试或换模）。停止后编辑与恢复驱动现仅保留原生 DSH、Codex CLI 与 Claude Code；其余长尾 CLI 编辑驱动与私有桥梁（StepCode、Muse Code、Poolside、ZCode、MiMo Code）已在 v2 退役。
- **结构化错误与超时**：OpenCode/Kilo 区分接口请求失败、上下文超限与结构化输出失败；OFM 转发遇到非 2xx 响应立即终止连接并向 DSH 报错，不冒充未收到的 HTTP 状态。Codex/ACP 仅提取明确错误类别、HTTP 状态和 RPC 错误码。
- **Token、上下文与推理档位**：外部 Harness 仅在官方协议确认本轮边界与独立 Token buckets 时接入 DSH 用量统计（缺失字段不补零、不按上下文估算）；上下文占用与窗口分别来自来源配置/CLI 回读，不代替接口容量探测。模型菜单仅在当前组合确认支持可选档位时显示推理设置，且延续与编辑前均实时核对能力；Codex/Claude/MiniMax 普通对话传入当前选择档位，外部 CLI 独立保存的档位不被原生模型投影覆盖。

## Windows Git Bash 与权限矩阵

外部程序的过滤环境保留 Git 安装根目录与显式 `OPL_GIT_BASH_PATH`（无效时拒绝启动，不改用其他 Shell）。Windows 增强包通过 Git for Windows 的 `bash.exe` 提供原生环境；工作目录若因官方 Windows ACL 后端返回 Win32 5，可由用户在管理员 PowerShell 中运行 Skill 的 `repair-acl --cwd <目录> --confirm yes` 后新建 `workspace-write` 会话验证（dispatch 不自动执行修复）。官方 `rc.2+` 的 Low-integrity restricted token 会阻止 MSYS2 外部程序创建 `\\BaseNamedObjects\\msys-2.0*`，导致 Git Bash 在 `workspace-write` 下仍可能触发 `0xC0000022`；需要运行外部 Git Bash 工具时须选用用户明确授权的 `danger-full-access`，不能自动提权或绕过限制。

| Harness | Git Bash 后端 | 完整访问与受限权限边界 |
| --- | --- | --- |
| Claude Code | 使用官方 `CLAUDE_CODE_GIT_BASH_PATH`，启动前验证 Git for Windows 路径 | 完整访问映射为官方 `bypassPermissions` 且关闭 sandbox；Windows 受限任务若无可用官方 sandbox 后端则拒绝 |
| Grok Build | 使用官方 `GROK_SHELL=bash`，按候选顺序核对首个实际存在的 Git 安装 | 显式完整访问映射为 `--sandbox off --permission-mode bypassPermissions`；Windows 只读/工作区任务在读取凭据与创建 profile 前拒绝 |
| Codex CLI | 官方 `0.160.1`/`0.161.0` 无模型探针仍为 PowerShell；自用候选须显式设置 `OPL_NATIVE_CODEX_GIT_BASH=1` 并通过 `thread/shellCommand` 实测 Bash | 权限映射为官方 `read-only`/`workspace-write`/`danger-full-access`（审批 `never`）；候选 Bash 仅接受显式完整访问，受限请求不自动放宽 |
| MiniMax mcode | 需支持 `_meta["minimax-code/shell"]` 回读的独立候选，详见[MiniMax 文档](minimax-code.md) | 仅接受显式完整访问并回读 `bypassPermissions`（Full access），不代答已挂起人工审批 |

各 Harness 保留自己的工具与会话，不通过提示词包装 `bash.exe` 伪装后端；自动生成组合的只读默认值不覆盖显式授权，已保存的受限会话不能在续作时扩大权限。除 Kimi 另支持 Plan 模式（工具层拒绝写入，非系统隔离）外，其余通用 ACP 执行器（OpenCode、Kilo、Pi、Mistral Vibe、Qwen Code 及自定义标准 ACP 引擎）在现行边界下均仅接受明确选择的完全访问并拒绝只读/工作区权限。

## Windows Codex Git Bash 边界

Windows 下 Codex CLI 使用配置中指定的官方 Codex CLI 或用户在「设置 → 执行引擎与协作」填写的可执行文件路径（旧版私有自建 `codex-candidate` 便携包与 `codex-runtime-select` 路径已在 v2 退役）。原生 DSH 的 Git Bash 支持（`src/shell/host/git-bash.ts` 与「通用设置 → DSH 使用 Git Bash」）及 Codex 协调器 Hook（`--shell powershell|git-bash`）继续按各自边界维护。

## 通用执行保护与验收

- **无进展超时保护 (`executionLimits`)**：统一约束原生和外部请求，默认 `firstProgressMs = 90000`、`idleProgressMs = 90000`（单位毫秒），保存后对后续轮次生效；排队、工具执行与公开人工等待暂停计时，心跳和空更新不延长等待。不设置单轮总时长上限（旧 `totalMs` 字段不再有效），超时仅终止本轮不自动重发。
- **取消、标题与并发**：用户停止轮次时先落盘取消标记再等待收尾，迟到 `end_turn` 不改写 cancelled 状态；普通会话初始标题取真实用户输入，不被注入上下文或空会话切换组合覆盖。
- **组合选择与串行一致性**：普通对话按“明确绑定 → 同源同模唯一默认 → 唯一启用组合”解析，首次发送固定选择；模型切换与发送按同一官方会话串行执行，切换失败或切换期旧请求均拒绝。同一快照的目录检查合并去重但不设有效期缓存，预检失败不清除已确认 CLI 档位显示但发送前仍强校验。
- **能力宣言与验收 (`HarnessAcceptance`)**：适配器声明传输、认证、协议、`customEndpoint`、权限、恢复、取消、推理档位与 Auto Review 类型。接入新来源或执行器须依次验证：来源与协议负例、真实登录/Key、真实工具事件、新建与恢复（保留会话 ID 与历史身份）、取消确认、权限与审批、Auto Review 及卸载恢复。

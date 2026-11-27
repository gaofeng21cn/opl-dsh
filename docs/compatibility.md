# 官方桌面兼容验证

稳定发布的执行顺序、证据边界和失败恢复见[稳定发布 SOP](release-sop.md)。本页只负责说明官方桌面资格脚本实际验证什么，以及哪些结果不能外推。

Linux CI 继续运行 Host / Client 类型检查、构建与全部自动测试。官方桌面兼容工作流在 macOS arm64 与 Windows 上下载并运行未修改的官方桌面，用独立数据目录验证增强包；它不需要模型账号，不访问实际用户 profile。

Linux x64 另有 `installer/install-linux.mjs` 的 CLI/Web 迁移入口。它使用独立自定义 profile、官方插件管理器和本机浏览器，必须通过实际 Host、控制 RPC 与执行组合回读验收；这些结果不属于官方 Electron Desktop 资格，也不能据此宣称 Linux Desktop 已发布。

当前兼容目标是官方 DSH `0.2.3-alpha.2` 的 Node/API cohort；实际 npm 版本以 `package.json` 与锁文件为准，升级依赖前必须通过新版编译和资格检查。官方桌面以两个安装 feed 的实时版本为准；稳定 Release 要求 macOS arm64 与 Windows x64 feed 版本相同，并在同一冻结版本上完成双平台隔离资格验收。官方版本带 `-alpha` 或 `-rc` 时仍属于上游候选阶段。任一平台资格失败或证据缺失都会阻断 Release。

Windows 的精确目标凭据继续通过 WinCred 读取。`@napi-rs/keyring@2.1.2` 的 `withTarget` 会在构造时写入空值，不能用于读取已有凭据。

安装器通过官方插件管理器安装或修复套件，并在已停止的 profile 上由官方加载器移除已退役的官方 Team bundle 引用；不在安装或迁移时自动启用官方 Auto Review bundle，也不修改应用资源。用户通过官方插件管理器主动开启或停用可选官方插件，已有禁用选择与 `opl-official-bundles.json` 回执保持不变。

## 本机验证

先运行 `npm run build`，再指定已安装的官方应用：

```sh
node scripts/qualify-official-runtime.mjs --app "$HOME/Applications/DeepSeek Harness.app"
```

Windows 的 `--app` 指向包含 `DeepSeek Harness.exe` 的目录。runner 校验官方签名与版本，通过官方插件管理接口向新建的临时 `opl-dsh-accept-*` profile 安装增强包，并指定独立 Electron user-data 目录。它只关闭自己启动的进程树；Suite、Skill 与安装回执均落在该临时根目录；不改用户 Skill 或快捷方式、不停止已有用户桌面。旧数据迁移固定读取临时空目录，避免导入真实账号和会话。

Windows 安装器为版本比较与增强安装脚本设置 `ELECTRON_RUN_AS_NODE`，运行官方安装程序前清除此标记。官方程序安装失败时保留实际退出码，不继续安装增强层。

隔离根目录由脚本使用 Node 的真实 `os.tmpdir()` 创建。macOS 的 `/tmp` 可能是指向 `/private/var/...` 的符号链接；不要手写 `/tmp/opl-dsh-accept-*`，否则会被隔离检查拒绝。

`--evidence <文件>` 指定证据 JSON，默认在 `dist/qualification-<平台>.json`。正常清理会删除临时 profile；排障时可用 `--keep-profile` 保留。保留目录含本次本地测试的控制令牌，不应上传整个目录。

## 验证覆盖与证据

runner 实际执行以下链路，任一步失败均返回非零退出码：

- 官方应用的签名、发布身份与版本校验；验收前后 `app.asar` 摘要一致。
- 增强包与安装文件逐项 SHA-256 校验，记录构建的源码修订、工作区是否有未提交修改、增强版本及套件摘要。
- 发布验收另外记录资格运行器的精确提交及清洁状态；运行器显式消费已冻结的交付包，产品身份始终以包内清单为准。
- 官方 Host 启动、控制绑定、认证后的 RPC、模型设置写入及官方模型目录回读。
- 官方能力清单读取 Team、Auto Review（挂载状态、默认关闭、不可默认直接选用）及官方一次性 Subagent provider 的版本、安装来源、启用状态和错误；启用的 Team 工具应由官方 Agent scope 提供，已被 Team 替代的顶层 `subagent`、`subagent_fork` 工具保持关闭。
- 在隔离项目中执行官方 Team lead → teammate 的真实父子任务，并通过官方 Session Controller 等待 lead 与 child；这只证明官方团队生命周期可用，不证明跨 Harness 交付验收已完成。
- 通过仅连接自有 Electron 的调试管道验证 OPL Client 挂载、首启与官方设置导航，打开「OPL Gateway」与「执行引擎与协作」页面（含默认规则与跨引擎协作折叠区）及模型页面；检查可见错误及运行异常，并保存截图。
- 本地模型 fixture 分别输出 DeepSeek messages 和 OpenAI completions 流；实际官方 Agent 执行工具并完成两次会话。外部 Harness 结束后，验收脚本继续轮询官方会话记录直至出现本轮 `turn/end`（上限 30 秒，超时失败），不把外部进程终态当作官方消息流已经落盘。
- 停止自有桌面并重新启动，回读已保存的组合选择与权限预设。

模型 fixture 证明协议、官方工具执行与本地持久化的兼容性；它不证明外部模型服务的网络、凭据或质量。API/RPC 通过不等于页面可见性验收通过，页面截图与可见性检查可定位加载回归；复杂布局、交互体验仍需结合截图审阅。`status: passed` 只表示 JSON 中列出的检查通过，不把跳过、排队或构建成功写成桌面通过。

## CI 与官方升级

`.github/workflows/official-compatibility.yml` 保留手动触发，并在主线或 PR 的依赖、源码、协议/构建、安装器及资格脚本变化时执行；发布事件也执行。两平台互不取消，失败时仍上传证据文件。配置下载或签名失败会直接失败，不降级为跳过。

CI 使用 `--download` 重用套件现有官方安装器的 HTTPS、SHA-512、签名与版本校验。macOS 使用明确的 arm64 runner。Windows 官方安装器会写入用户注册表和系统快捷方式，因此下载模式仅允许在临时 GitHub Actions runner 执行；开发机器请使用已有官方应用的 `--app` 模式。

每次证据都记录实际运行的 `officialVersion`，而不是把开发依赖固定版本当成桌面版本；同时记录官方能力清单及 bundle cohort。官方更新清单会变化，应以对应构建摘要的成功证据为兼容结论。跨平台工作流尚未运行时，仅能报告本机实际执行的平台结果。若官方新增与 OPL 保留功能等价的能力，先在该隔离资格路径验证，再切换调用者和唯一状态 owner，最后删除重复实现。

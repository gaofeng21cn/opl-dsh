# 开发与验证

OPL DSH 独立维护增强包，复用未修改的官方 DeepSeek Harness 桌面。公开产品版本跟随官方 DeepSeek Harness；插件内部修订号只用于兼容、回滚和自动更新。支持 Apple Silicon Mac 与 Windows x64。

## 代码与构建

- `src/gateway`：账户、分组密钥、模型通道、原生网页搜索与故障切换。
- `src/coordination`：协作设置、任务等待、持久化反馈与可选 Codex 队列桥。
- `src/coordination/harness.ts`：外部 Harness 组合的 ACP 子进程、会话恢复、连续提示和取消。
- `src/client`：Gateway、首启和协作设置界面。
- `installer`：官方包校验、独立 profile、旧数据导入、快捷入口、Skill 及增强自动更新。
- `install.sh` / `install.ps1`：公开终端入口，选定最新 Release 后下载同一版本的增强 ZIP 与 SHA-256 清单，校验后调用现有安装器。
- `Casks/opl-dsh.rb`：直接以本仓库作为 Homebrew Tap，固定增强 ZIP 的发布地址与 SHA-256；安装时仍动态获取最新官方桌面。

开发需要 Node.js 24；分发安装器使用 Python 3、macOS 系统工具和 NSIS（`brew install nsis`）生成。使用者无需单独安装这些运行时。

```sh
npm ci
npm run typecheck
npm run build
npm test
# 在 macOS 构建两平台入口和内部增强包
node package.mjs
```

构建输出插件 tarball、带逐文件 SHA-256 的安装清单及Mac DMG 和 Windows EXE 在线安装器。桌面官方服务保留为 runtime peer，插件不携带另一套 Agent 循环。`dsh-llm-pi-ai` 为官方协议适配库，备用通道不会改用 Pi Harness。

新增正式 Release 后，同步更新 Cask 的 `version`（官方版本、OPL 发布修订）和增强 ZIP 的 `sha256`，不得指向可变的 latest 下载地址。终端入口自动解析 latest，无需更新脚本。Cask 只调用 `install.command --no-launch`，不维护第二套安装实现；卸载保留官方桌面、数据和 Skill，只移除经过归属校验的默认快捷入口。

## 模型 + Harness 组合

组合由 `harness.ts` 按 `组合 ID + 工作目录 + 外部会话 ID` 管理。首个外部组合为 `grok-build/grok-4.7`：Host 启动官方 `grok agent stdio`，通过 ACP 发送提示词、接收流式文本和工具状态，默认拒绝权限请求，并把会话 ID 保存到独立的 `harness-sessions.json`。DSH 重启后使用 ACP `session/load` 恢复，不把 Grok 的会话文件转成 DSH V4/V5 格式。

DSH 原生工具 `delegate_to_harness` 与 Codex Skill 的 `delegate`、`delegate-start`、`delegate-prompt`、`delegate-snapshot`、`delegate-cancel` 共享同一个 Host 管理器。它们都会在当前项目目录创建或恢复独立 Harness 子对话并返回结果；Skill 不把 Grok 任务伪装成 DeepSeek Session，也不复用 DeepSeek/Codex 的 key。登录 OPL Gateway 后自动申请 Grok 分组密钥，Host 通过 `GROK_CONFIG` 的 `env_key` 注入，不把密钥写入 Grok 配置文件。Grok 保留自己的工具、上下文和会话状态；权限请求默认拒绝，不会绕过 DSH 的权限边界。

实现顺序是先复用这一 ACP Host 管理器接入其他官方 Harness，再增加设置页中的组合选择器和跨组合衔接摘要。当前首版命令路径已覆盖 Grok 的连续对话、工具调用、权限拒绝、取消和进程重启恢复；Windows 以及 Claude 组合尚未宣称已验证。

## 安装位置

| 内容 | macOS | Windows |
| --- | --- | --- |
| 套件与数据 | `~/Library/Application Support/OPL DSH Suite` | `%APPDATA%/OPL DSH Suite` |
| 官方桌面 | `~/Applications/DeepSeek Harness.app` | 优先复用官方已安装位置；首次为套件下 `runtime/DeepSeek Harness` |
| OPL 快捷入口 | `~/Applications/OPL DSH.app` | 开始菜单 `OPL DSH` |
| Codex Skill | `~/.codex/skills/opl-dsh-official` | `%USERPROFILE%/.codex/skills/opl-dsh-official` |

套件内 `data` 为独立 `DSH_HOME`，`releases` 保留已安装增强，`installation.json` 记录有效版本与路径。可用 `OPL_CODEX_HOME` 指定 Skill 安装位置；用户手动修改的 Skill 不会被静默覆盖。配置中的自动启动偏好随更新保留。

## 版本与两套更新的边界

公开 Release 使用 `dsh-v<官方版本>-opl.<修订>` 标识，主标题展示官方版本；`enhancementVersion` 仅作为内部递增修订。旧 0.2.x 安装器把 GitHub tag 当内部版本，需运行一次新安装器过渡；新更新器从校验过的增强清单读取修订号，不再耦合公开 tag。

Mac 已安装的官方桌面若不旧于当前 feed 则复用；Windows 优先检查 installation.json 或官方卸载注册表记录的路径，避免官方自行升级后装回旧版本。签名和版本验证始终保留。

官方桌面由官方更新器负责。OPL 快捷入口在启动官方进程前调用 `update.mjs`，读取本仓库最新正式 Release 的 `OPL-DSH-Enhancements.zip`，验证 GitHub 资产摘要、内部清单及每个文件，再使用官方插件管理器安装。增强更新不会重装或修改官方桌面。

运行中 profile 会跳过更新；同一更新过程使用独占锁；离线或验证失败继续旧版。安装失败会尝试恢复上一增强版本。状态写入 `enhancement-update.json`，旧 release 与源数据保留。安装器读取官方桌面 `nightly-mac.yml` / `nightly.yml`，验证清单中的平台下载地址、SHA-512 和 DeepSeek 发布者签名；插件核心依赖保留 runtime peer，不以 SemVer 上限拒绝未来版本（包括 RC）。开发依赖仍固定以保证可复现；官方 API 实质变化仍需重新验收和适配。

首次欢迎衔接使用父子私有 CDP pipe，通过能力检测调用官方 skip 方法；接口不存在时保留官方欢迎窗口。生产启动不开放 TCP 调试端口，不修改官方签名资源。测试时使用过仅隔离环境启用的 pipe relay，它不包含在分发包内。

## 旧数据

首次安装只在目标不存在时复制旧会话、关联存储、偏好与本产品凭据，排除锁文件、旧运行时 profile 和浏览器鉴权 token。复制前后核对文件大小与修改时间，原目录不变。macOS 默认来源为 `~/.dsh-opl`，Windows 为 `%APPDATA%/@deepseek-ai/dsh-desktop/dsh-home`。

检测到 V5 或更新开发格式时，不导入整组会话及关联存储，记录 `historySkipped`；不把不受官方支持的文件伪装成已迁移。V3 公开版已实际导入并打开。V5 核心格式补丁和旧桌面壳不再维护。

## 验证

发布检查包括 Host/Client 类型检查、模型与故障切换、协作幂等派发、持久化反馈、通知子进程、安装包完整性、更新拒绝条件及迁移边界测试。

隔离官方桌面验收覆盖 macOS 与 Windows 的安装、启动、应用内首启和协作设置。macOS 已使用真实 Gateway 模型执行工具任务、生成结果并保存完成反馈；增强更新后登录、会话、反馈和自动启动偏好保留。官方账号完整外部授权不使用测试人员代登录，已验证授权发起与取消。

测试通过不等于公开发布：发布后须回读 Release 资产及摘要，并验证公开增强资产的实际下载更新路径。

# 开发与验证

OPL DSH 独立维护增强包，复用未修改的官方 DeepSeek Harness 桌面。当前增强版本为 0.2.1，配套验收的官方版本为 0.1.7-rc.2，支持 Apple Silicon Mac 与 Windows x64。

## 代码与构建

- `src/gateway`：账户、两组密钥、模型通道与故障切换。
- `src/coordination`：协作设置、任务等待、持久化反馈与可选 Codex 队列桥。
- `src/client`：Gateway、搜索、首启和协作设置界面。
- `installer`：官方包校验、独立 profile、旧数据导入、快捷入口、Skill 及增强自动更新。

开发需要 Node.js 24；分发 ZIP 使用 Python 3 标准库写入跨平台 UTF-8 文件名。使用者无需单独安装这些运行时。

```sh
npm ci
npm run typecheck
npm run build
npm test
# 在 macOS 构建两平台分发 ZIP
node package.mjs
```

构建输出插件 tarball、带逐文件 SHA-256 的安装清单及平台入口 ZIP。桌面官方服务保留为 runtime peer，插件不携带另一套 Agent 循环。`dsh-llm-pi-ai` 为官方协议适配库，备用通道不会改用 Pi Harness。

## 安装位置

| 内容 | macOS | Windows |
| --- | --- | --- |
| 套件与数据 | `~/Library/Application Support/OPL DSH Suite` | `%APPDATA%/OPL DSH Suite` |
| 官方桌面 | `~/Applications/DeepSeek Harness.app` | 套件下 `runtime/0.1.7-rc.2/DeepSeek Harness` |
| OPL 快捷入口 | `~/Applications/OPL DSH.app` | 开始菜单 `OPL DSH` |
| Codex Skill | `~/.codex/skills/opl-dsh-official` | `%USERPROFILE%/.codex/skills/opl-dsh-official` |

套件内 `data` 为独立 `DSH_HOME`，`releases` 保留已安装增强，`installation.json` 记录有效版本与路径。可用 `OPL_CODEX_HOME` 指定 Skill 安装位置；用户手动修改的 Skill 不会被静默覆盖。配置中的自动启动偏好随更新保留。

## 两套更新的边界

官方桌面由官方更新器负责。OPL 快捷入口在启动官方进程前调用 `update.mjs`，读取本仓库最新正式 Release 的 `OPL-DSH-Enhancements.zip`，验证 GitHub 资产摘要、内部清单及每个文件，再使用官方插件管理器安装。增强更新不会重装或修改官方桌面。

运行中 profile 会跳过更新；同一更新过程使用独占锁；离线或验证失败继续旧版。安装失败会尝试恢复上一增强版本。状态写入 `enhancement-update.json`，旧 release 与源数据保留。安装包内的首次官方下载版本固定，后续官方更新可能改变运行时版本；目前 peer 范围为 `>=0.1.7-rc.2 <0.2.1`，这不是对所有未来版本的验收承诺。

首次欢迎衔接使用父子私有 CDP pipe，仅调用官方 skip 方法；对未知官方版本保留官方欢迎窗口。生产启动不开放 TCP 调试端口，不修改官方签名资源。测试时使用过仅隔离环境启用的 pipe relay，它不包含在分发包内。

## 旧数据

首次安装只在目标不存在时复制旧会话、关联存储、偏好与本产品凭据，排除锁文件、旧运行时 profile 和浏览器鉴权 token。复制前后核对文件大小与修改时间，原目录不变。macOS 默认来源为 `~/.dsh-opl`，Windows 为 `%APPDATA%/@deepseek-ai/dsh-desktop/dsh-home`。

检测到 V5 或更新开发格式时，不导入整组会话及关联存储，记录 `historySkipped`；不把不受官方支持的文件伪装成已迁移。V3 公开版已实际导入并打开。V5 核心格式补丁和旧桌面壳不再维护。

## 验证

发布检查包括 Host/Client 类型检查、模型与故障切换、协作幂等派发、持久化反馈、通知子进程、安装包完整性、更新拒绝条件及迁移边界测试。

隔离官方桌面验收覆盖 macOS 与 Windows 的安装、启动、应用内首启和协作设置。macOS 已使用真实 Gateway 模型执行工具任务、生成结果并保存完成反馈；增强更新后登录、会话、反馈和自动启动偏好保留。官方账号完整外部授权不使用测试人员代登录，已验证授权发起与取消。

测试通过不等于公开发布：发布后须回读 Release 资产及摘要，并验证公开增强资产的实际下载更新路径。

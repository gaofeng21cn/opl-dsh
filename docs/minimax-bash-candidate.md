# MiniMax Bash 候选版：构建与选择

当前 Windows 候选基于官方 npm `@minimax-ai/code@0.7.7`。官方分发文件与账号实现保持原样，OPL 扩展单独存放在 `overlay/`；它使用原生 Git Bash 绑定，并提供 ACP Shell 回读（`_meta["minimax-code/shell"]`）、仅对话历史的编辑、官方登录取消与授权到期处理。标准 CLI 不能仅凭环境变量代替能力验证。

## 当前 0.7.7 候选构建

固定输入在 `src/execution/host/candidates/mcode/distribution.json`，官方文件清单在 `src/execution/host/candidates/mcode/official-0.7.7-files.json`。构建先核对 npm 归档 SHA-512、官方公开许可 SHA-256 与逐文件摘要，再安装依赖并重新核对原始文件，生成含便携 Node 的完整清单（`filesSha256` 为官方文件列表经 `JSON.stringify` 序列化的 SHA-256）。

```powershell
node scripts/mcode-candidate/build-distribution.mjs --out "D:/mcode/0.7.7-opl-bash.20261119.1" --archive "D:/downloads/code-0.7.7.tgz" --node "C:/Program Files/nodejs/node.exe" --license "D:/downloads/MiniMax-LICENSE" --proxy http://127.0.0.1:7897
node scripts/mcode-candidate/verify-candidate.mjs --candidate "D:/mcode/0.7.7-opl-bash.20261119.1" --out "D:/mcode/verification"
```

构建支持 Windows 与 Node 24–26；overlay 依赖该 npm 包的固定导出，升级官方版本必须重新核验导出、协议和真实工具。原 `0.7.4` 清单与历史 `0.6.3` 源码补丁构建脚手架分别保留在 `src/execution/host/candidates/mcode/`（`candidate.json`）与 `scripts/mcode-candidate/build-candidate.mjs`。

## 安全与写入边界

- **独占 `--out` 与受保护路径**：所有写入与派生路径在写入前按真实路径（含符号链接/junction 祖先）判定；`~/.minimax`、`~/.minimax-code-data`、`~/.config/mcode`、`~/.minimax-code`、PATH 上的官方启动器目录、`OPL_DSH_HOME`/`~/.dsh`、`%APPDATA%/OPL DSH Suite` 及 `--protect` 声明目录双向不重叠（`lifecycle.mjs` 仅可写套件自有 Store `harnesses/MiniMax Code`）。
- **无凭据、不改系统 PATH**：不复制官方登录数据，组装后扫描 `auth`/`tokens.json`/`.npmrc` 等凭据文件名，发现即失败；先验校验（摘要、许可、启动器语法、`toolchainStubbed`）任一失败即零执行（`executionGate.candidateCodeExecuted=false`）。
- **五条导入闸门**：版本匹配 `<官方版本>-opl-bash.<YYYYMMDD>.<序号>`、目录内 `package.json` 身份一致、清单逐文件 SHA-256 与字节数全覆盖、bundle 含真实 Shell 与会话历史能力标记、许可文件齐全并受摘要覆盖；拒绝目录内符号链接与逃出目录的原生模块闭包。
- **启动器与事务保护**：逐行校验 `mcode.cmd` 模板及内嵌/显式 Node 运行时；`--replace` 不得替换当前已选版本，导入与选择通过暂存目录校验后原子切换，失败保留原目录并把拒收产物改名为 `<版本>.failed-<ts>`。摘要一致性不等于官方签名认证。

## Host 选择与验收要求

`lifecycle.mjs` 仅维护本地 Store 与审计回执 `selection.json`，**不会**改变 DSH 的真实运行时选择。让选择在 DSH 中生效，需在设置 → 执行与组合 → 执行引擎与网络代理的 MiniMax Code 卡片填写可执行文件路径，或通过已安装协作 Skill 调用 Host 选择接口：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<Skill>/control.mjs' minimax-candidate-select --version 0.7.7-opl-bash.20261119.1 --source 'D:/mcode/0.7.7-opl-bash.20261119.1'
```

省略 `--source` 会重新校验并选择已导入版本。Host 先检查同一运行实例所有项目的活动任务、组合轮次与维护互斥，校验通过后原子发布实际 `command` 与空 `prefix`；失败保留原选择，切换不改变官方安装与 `~/.minimax` 登录状态。

静态校验（`verify-candidate.mjs`、`lifecycle.mjs verify`）仅证明文件与标记完整，不能替代实机验收；正式交付仍须在未修改官方桌面中验证真实 ACP `initialize` Shell 回读、实际 Git Bash 工具执行（非零退出码、中文/空格路径、取消后代清理）、真实模型与推理档位、仅对话编辑及官方登录/取消流程。

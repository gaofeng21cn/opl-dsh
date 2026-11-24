# OPL DSH 文档导航

本目录是 OPL DSH（官方 DeepSeek Harness 增强套件）的文档唯一真相归口；每份文档只承担一项长期职责，历史版本说明由 GitHub Releases 与 Git tag 持有，不在本目录累积留存。

## 用户与配置指南

| 文档 | 职责 |
| --- | --- |
| [首次启动与登录](first-run.md) | 桌面/Linux 首启、登录路径（含 Windows 记住密码）与官方欢迎窗口衔接 |
| [日常使用指南](everyday-guide.md) | 无项目聊天、会话清理、编辑与轮次统计、通用设置、文件交付、系统通知、Todo 状态、超时与用量 |
| [模型与执行组合指南](model-harness-guide.md) | 用户侧模型来源、执行引擎检测/更新与执行组合上手指南 |
| [官方 MiniMax 账号与 mcode](minimax-code.md) | MiniMax 官方账号与 `mcode` 集成、登录、代理、权限与 Skill 委派 |
| [MiniMax Bash 候选版](minimax-bash-candidate.md) | Windows `mcode` 候选版构建、安全闸门与 Host 选择契约 |
| [从 Codex 委派任务给 DSH](codex-task-delegation.md) | 从 Codex 委派任务给 DSH 的配置、回执与核对指南 |
| [桌面观察与操作（Computer Use）](computer-use.md) | macOS KimiCU / Windows WinCU 桌面观察与操作指南 |

## 协作、审批与功能契约

| 文档 | 职责 |
| --- | --- |
| [事件驱动的项目续作](project-coordinator.md) | 项目协调器计划、Hook、Watcher、审查回执与恢复边界 |
| [跨 Harness 团队接入](cross-harness-team.md) | 跨 Harness 团队接入与 OPL 领域智能体预设 |
| [Auto Review 工具审批](auto-review.md) | 原生 Auto Review 边界、OPL 路线与 StartLux/Jev 决策模型 |
| [编辑消息](stop-edit.md) | 停止后编辑重发与外部 CLI 分支/恢复技术契约 |
| [Agent 原生应用与 MCP Apps](mcp-apps.md) | 无 UI 应用交接诊断与当前官方 MCP Apps 公开接口缺口 |
| [并行写入与工作树](parallel-writes.md) | 并行写入、官方 worktree 与窄 `writeScope` 长期约束（`AGENTS.md` 引用） |
| [SuperAgent 仓库协作](superagent.md) | SuperAgent 仓库协作原型接入与独立实例边界 |

## 架构、开发、验证与发布

| 文档 | 职责 |
| --- | --- |
| [模型、Harness 与组合架构](model-harness-architecture.md) | 模型、Gateway 分组与断流恢复、OFM 接入、执行组合与 UI 导航架构 |
| [外部 Harness 适配准备](harness-adaptation.md) | 显式来源注册、OFM 渠道与执行器适配表、Windows Git Bash/ACL 与 Codex 候选边界、通用执行保护 |
| [官方 DSH 能力复用检查](dsh-reuse-audit.md) | 官方 DSH 能力复用检查与迁回条件表（`AGENTS.md` 引用） |
| [开发与验证](development.md) | 功能接入与 UI 成本判断、目录与模块边界、构建/RPC/数据位置、Linux/Windows 本地边界 |
| [官方桌面兼容验证](compatibility.md) | 官方桌面隔离资格脚本、覆盖范围与 CI 边界 |
| [发布约定](release-policy.md) | 联合稳定版本发布合同（每日检查、Writer 链、命名、自动更新与历史策略） |
| [稳定发布 SOP](release-sop.md) | 稳定发布/回读/恢复操作 SOP 与 Release Note 模板 |

## 机器消费与静态资产

- `docs/plugins/*.md`（6 份）：由 `scripts/build-feature-plugins.mjs` 打包为三个拆包插件的离线中英文详情说明，勿按普通说明删改文件名。
- `docs/images/guides/`：用户指南嵌入截图资源。

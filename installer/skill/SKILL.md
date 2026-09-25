---
name: opl-dsh-official
description: 使用官方 DeepSeek Harness 桌面版和 OPL 插件执行独立任务；自动启动应用，按操作 ID 幂等派发，读取结果与等待状态。
---

# OPL DSH 官方桌面协作

配置位于本 Skill 的 `config.json`。运行 `control.mjs` 时使用配置中的 `executable`，并设置 `ELECTRON_RUN_AS_NODE=1`；helper 会在需要时启动官方桌面。不得读取或回显 control.json 中的 token。

派发前，为任务选择绝对工作目录，把提示词保存为 UTF-8 文件。使用稳定的 task 与 operation ID；对同一次失败重试必须沿用原 ID，不得换 ID重复执行。

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' dispatch --task task-id --operation initial --cwd /absolute/project --prompt-file /absolute/prompt.txt
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' wait --session session-id
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' snapshot --session session-id
```

同一 task 的后续指令使用新的 operation ID，helper 保留同一个 DSH Session。需要用户授权或补充信息时报告真实等待状态；不自动扩大权限。任务完成后读取 snapshot，独立检查产物。默认使用 opl-gateway/deepseek-flash；可用 `--provider opl-gateway-openai` 直接选择备用通道。

## 模型 + Harness 执行组合

当前可用的外部组合是 `grok-build/grok-4.7`。当当前 Codex 对话要求让 Grok Build 在同一项目执行任务时，运行：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate \
  --combination grok-build/grok-4.7 \
  --cwd /absolute/project \
  --prompt-file /absolute/prompt.txt
```

这会在同一工作目录创建或恢复一个独立的 Grok Build ACP 会话，结果回到当前 Codex 对话。后续要求继续同一个外部会话时传 `--session <session-id>`，也可使用 `delegate-cancel` 和 `delegate-snapshot`。Grok 保留自己的工具、上下文和会话状态；权限请求默认拒绝，不读取 DeepSeek 或 Codex 的密钥。

任务会在派发前登记到持久化反馈服务。可使用 `tasks`、`outbox`、`wake` 查看任务、通知与回调状态；`task`、`receive`、`consume`、`resumeFailed` 接受 `--request-file` JSON 请求。需要接收回调时，在 DSH 的“设置 → Codex 协作”配置实际可用的 Codex 队列桥；未配置或探测未通过时，不得声称能够后台唤醒 Codex。继续、重试和回调验收必须核对任务与会话，权限和结构化问题由用户在 DSH 中决定。

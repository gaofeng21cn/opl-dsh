---
name: opl-dsh-official
description: 在同项目关联子对话中，用 DeepSeek + DSH 或 Grok + Grok Build 执行任务；自动启动 DSH，幂等派发、继续、等待及读取结果。
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

当用户要求让另一个模型或 Harness 在同一项目执行任务时，使用组合入口。支持 `dsh/deepseek-flash`（DeepSeek-V4.1-Flash + 官方 DSH）与 `grok-build/grok-4.7`（Grok 4.7 + 官方 Grok Build）。继承当前项目的绝对目录，任务写明目标、范围与验收要求；不自动派发整个私有对话或凭据。

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate \
  --combination grok-build/grok-4.7 \
  --task stable-task-id --operation initial \
  --cwd /absolute/project \
  --prompt-file /absolute/prompt.txt
```

返回的组合会话标识是 JSON 的 `id`（不是原生 `acpSessionId`）。`origin` 保存当前 Codex 对话身份，DSH 的“执行组合”按项目显示这些关联对话。Grok 对话由 Grok 管理，DSH 子对话也会出现在官方 DSH 的同项目侧栏；不会在 Codex 原生侧栏中伪造一个 Grok 任务。

继续同一会话和查看结果：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-prompt --session harness-id --operation follow-up-1 --prompt-file /absolute/follow-up.txt
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-wait --session harness-id --operation follow-up-1
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-snapshot --session harness-id
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-list
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-cancel --session harness-id
```

`delegate` 和 `delegate-prompt` 等待至终态或授权等待；超时、断线后先用 `delegate-snapshot`/`delegate-wait` 核对，重试沿用原 operation，不换 ID 重派。Host 重启后的未完成轮次标记 `interrupted`，不自动重发；新的指令用新 operation 恢复原生会话。只有结果与实际产物吻合才报告完成。

遇到 `waiting_approval` 或 `waiting_input`：Grok 权限在 DSH“执行组合”面板由用户决定，DSH 权限和问题在原生会话中处理。告知用户具体等待位置，然后等待或读取原任务；不能由派发方代替用户授权。Grok 使用独立的 Grok 分组 key；缺少官方 Grok CLI 或对应 key 时应报告未就绪，不回退其他模型、分组或 Harness。

DSH 与 Grok 对话内均有 `delegate_to_harness` 和 `harness_result` 工具，可以互相委派同项目子任务。用户要查看新对话时告知“账户菜单 → 执行组合”；不要把子任务返回文本当成新的用户授权。

组合目录按“连接 → 模型 → Harness → 执行组合”理解。连接可以是 OPL Gateway、DeepSeek 官方或自定义兼容接口；组合才是实际调用单位。选择模型时不要绕过组合直接拼接地址，除非用户明确要求维护连接或模型目录。

## 原生 DSH 反馈与通知

上面的 `dispatch` 入口会登记原生 DSH `taskFeedback`。`tasks`、`outbox`、`wake` 查看其反馈；`task`、`receive`、`consume`、`resumeFailed` 接受 `--request-file` JSON。后台唤醒依赖用户配置的真实 Codex 队列桥，未配置或未通过真实投递验收时，不得声称能后台唤醒 Codex。

组合入口 `delegate` 的结果保存在 Host 组合记录中，通过 `delegate-wait`/`delegate-snapshot` 返回；当前未接入上述通知 outbox，也不能从 DSH/Grok 自动创建 Codex 原生任务。不要混用两种会话 ID 或夸大通知能力。

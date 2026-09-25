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

此基线支持派发、续接、等待、快照和取消。它不承诺 DSH 在 Codex 任务停止后主动唤醒 Codex；旧版 task-feedback 反向唤醒尚未移植。

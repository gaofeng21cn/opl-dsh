# Windows KimiCU code-mode entry

Status: implemented

## Problem

Windows KimiCU 的 native `kimi-cu.exe` 是共享 Agent；Mac 的 `mcp -s user` 参数和动作词汇不能用于该程序。用裸文件名做存在检查也不会搜索 PATH。

## Decision

Windows 固定使用官方完整插件的 `runtime/node-repl.exe`，初始化后验证广告的 `js` 工具。DSH 只将受权限门禁约束的动作和 JSON 参数编码为固定 `@kimi/cu` 调用，截图保留 MCP image blocks；不开放任意 JavaScript。新连接的初始化共享同一 Promise；取消、截止和关闭清理自有前端，不停止共享 native Agent，不自动重放输入。

安装器按官方版本清单与签名验证完整插件和 runtime，组件存放于套件目录，启动器向 Host 传入同一版本的绝对路径；不依赖调用进程的 LocalAppData 视图。安装文件通过不代表运行时可用，调用时仍验证 MCP 与实际桌面结果。

## Verification

聚焦检查覆盖不完整目录、未广告 js、数据转义、初始化并发、图片映射、取消和关闭。真实官方 0.3.10 插件在 Windows 上完成记事本窗口发现、中文输入和截图回读；DSH 模型调用结果单独记录。

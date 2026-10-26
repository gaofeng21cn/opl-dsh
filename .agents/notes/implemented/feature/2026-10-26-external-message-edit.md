# 外部 Harness 同会话编辑

外部会话的用户可见身份由 nativeSessionId 持有；后台 ACP 身份可以在精确边界分支后接替。编辑必须同时核对当前官方表面上的用户事件与底层消息身份；重复文本、相同条数和摘要不能建立身份对应。

共享 Host 负责底层操作前的 durable intent、返回结果、接替身份和 replacement prompt 的一次准入。driver 只做底层读取与回退，不发送替换提示，也不提交 DSH 记录。invoking、admitting 或 prompting 的未知结果在重启后仍阻断发送。读状态不触发重试。

Pool 回放单独收集底层 user chunk 与 inputEventId，不以预先修改本地 turns 来证明底层成功。临时控制服务必须确认退出，关闭错误不能变成成功结果。ZCode 首条缺少完整配置继承接口，明确拒绝。

Codex 的 Git Bash 校验必须等待内部 turn/completed，不能在 commandExecution 完成时释放；晚到的校验完成事件会误结束下一条用户请求。历史比对保留内部 userShell 项，但仅用户输入形成可编辑边界。Runtime 与时间等注入上下文独立展示在模型请求内，不归类为历史用户任务。

Kimi 的只读控制会重连 ACP；连接观测更新时间不代表消息或权限变化，编辑指纹仅排除 updatedAt。OpenCode/Kilo 的控制服务从适配器登记的原始 CLI 路径与 prefix 启动，不反解 Windows cmd 包装字符串。ZCode 分支会同步重建工具行的 entityId/toolCallId；仅两边各自相等时接受这一身份重映射，工具输入和输出仍逐字段核对。

Pi 的空分支尚未写入历史文件时，桥接器已切换到新身份；共享 owner 同步更新活动连接的会话 ID，再对新身份固定模型并发送替换消息。

外部编辑的明确错误响应与传输中断分别记录。失败后的恢复必须同时匹配持久编辑请求、官方用户事件和底层完整输入前缀；只有已结束输入才释放 prompting。admitting 证明替换从未发送，允许用户用新请求继续同一分支。Pi 空分支在落盘前丢失时，用户明确再次编辑才分配新的底层空身份；分配前记录意图，发布前禁止连接事件写入会话。

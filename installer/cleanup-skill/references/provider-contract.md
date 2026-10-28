# Provider 检查清单

永久删除前读取当前官方包版本和实际 provider 的公开声明，确认是否存在受支持的 session delete/retention 方法。仅有 `SessionStore` detach、Workspace detach、unarchive、列表过滤或 `session/disposed` 事件都不算持久删除。

当前 rc.3 的公开 `SessionPersistence` 方法是 `create`、`open`、`flush`、`stat`、`list`；`SessionHandle` 提供 `read`、`append`、`flush`、`close`。这些接口没有删除或撤销 owner 的方法。看到未知 provider、无法解压的代际日志、共享附件或未公开索引时，永久模式必须停止。

需要上游删除协议时，要求它定义 admission 拦截、writer/reader drain、跨进程 fencing、代际与迁移文件清理、Workspace/搜索/投影同步、附件引用语义、删除事件、tombstone 和重启验证。没有完整协议时只能回收或归档隐藏。

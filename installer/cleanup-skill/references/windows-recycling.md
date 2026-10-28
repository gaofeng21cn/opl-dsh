# Windows 回收站核验

回收前先记录精确原路径、大小、SHA-256、文件集合和清单版本。目标必须位于当前 DSH 数据根或当前 OPL profile 允许的外部记录根内，不能是符号链接、junction、根目录或重定向父目录。

使用 `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` 或 `DeleteDirectory`，指定 `RecycleOption.SendToRecycleBin` 和 `UICancelOption.ThrowException`。每项成功后立即写入进度文件。通过回收站 `$I` 元数据匹配完整原路径和本轮时间，再用对应 `$R` 内容逐文件核对哈希；匹配不唯一或内容不一致就停止。

索引只有在所有目标回收并验证后才可变更。保留索引原始字节、目标 ID、回收路径和恢复顺序。恢复时重新核对当前索引和原路径，按 ID 合并，不能直接覆盖后来产生的索引。

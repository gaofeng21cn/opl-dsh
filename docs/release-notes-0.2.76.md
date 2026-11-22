官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本版更新内容见以下提交记录及对应功能文档。

### 变更

- Enable Billion Context by default in native DSH profiles ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/bba5409302c3373fd4ee613d4e133d5db61a8b1b))
- release: prepare OPL DSH v0.2.75 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/e7ccf80c9be395025857dcf7480e88f1fd87e29c))
- Coordinate engine updates with active sessions and external installers ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/227656872501e612dad6e10d666411f9cd2de347))
- Keep MiniMax region selection available after malformed CLI preferences ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/87575fa8232534844901caf512ba3399b63a32f9))
- Preserve established Gemini and AMD Qwen combination routes ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/83fccd054a69a4de3f73770d39cfb0da7bee8fff))
- Verify the update before restoring a managed helper ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/c2258d91c9a711f97298591488080f4e08c6d849))
- 精简 OPL Gateway 模型选择与手动配置布局 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/afe18adb527011f6911062039b82b10df7af51f7))
- 为七个 EAC OpenCode 模型登记独立转发组合 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/fbfaa911c10fcc6f34c24328399fcaff62e01545))
- 统一权限标签与组合列表的字号和行距 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/1832188b8bf2a3a4add0103a88dee5e7074e4a41))
- 按原安装清单恢复缺失的 macOS 协调器程序 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/49ece33b1ec84e5118bb9a51b90874ccc6d2258b))
- 并行更新独立引擎并识别桌面应用内置 Codex ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/d45f481f35d7e687d4dc9faa21d5ed1478b90b1f))
- 在执行组合选择列表标明仅支持完全权限的引擎 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/66da44ccfe422541c192f719dfc2ad597155da87))
- Keep saved Gemini OpenCode alternatives out of bulk selection ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/c15b98aef87a1f0b6a0d0e5e6e2df6721f0b36ef))
- 更新已保存的 EAC Qwen Code 旧推荐名称 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/b3e224d09891624f30edbcd4a28cb7d48b8f8f48))
- Apply project formatter ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/5d426e3f58477e8b0730fe39542b38d95ffdd6e0))
- 支持批量检查执行引擎更新并在可用时提醒 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/a5d5d228b9e63f261eb687ee04168f31386dd52c))
- Gemini 和 EAC Qwen 默认展示官方组合，保留手动备选 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/f681f27e5ac25f0a1bf80896f21a0e092ddb9a62))
- 在模型供应商中统一管理 MiniMax Code 的启用状态和使用地区 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/c961d2047ff0f879471fc7a90747cb6bbf4459c3))
- 将 Windows 会话退出脚本纳入发布校验清单 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/15e5026a7ca640f32eae8a899094381dbc548092))

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制


- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:mechanical -->

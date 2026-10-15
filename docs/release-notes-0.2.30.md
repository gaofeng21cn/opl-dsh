官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本版收录以下尚未交付的增强层主线改动。自动语言整理不可用，以下保留原始提交说明；具体行为以对应提交和功能文档为准。

### 变更

- fix: deliver current release fixes and accept canonical workspace paths (#16) ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/7ae99518f9d8ceed4b1b3b5491ddab3226643e0d))
- fix: make projectless new sessions usable (#15) ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/ad33bcd7ec2f6cff3385384ea1b8bd0c5a607ed9))
- fix: keep optional hero slot from unloading execution UI ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/24ba99a7fbfc51865d280576cb3be93b68314d65))
- fix: bind projectless hero navigation directly ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/dd05c1d2a41a225bdb4dcaa1fe356cd8bc3c5231))
- fix: preserve settings sections when hero slot is lazy ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/d51ba4f914271448fcc5db7e9071da50ef93f86e))
- fix: complete OFM lifecycle and install workflow ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/fadb2e9a34e72e4653c4927849050457c08a2e97))
- Isolate reasoning probes from durable Harness tasks ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/5cca589b572702ca5ecf6a3c53ad310b9d7f6057))
- Preflight external reasoning options before display ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/2cff0b123cb5805f8f0f260dfa108ca87fa8fa23))
- Reject empty Muse turns without completed work ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/6aa10c5eb927077e03f471a5342109421ca76a33))
- Fix portable Harness tests, empty results and credential qualification timing ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/8ed720091314eb9f455a0d9c00943c22bd23d0a7))
- Add OFM Harness adapters and fix first-send permissions and edit state ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/31fc5e8dc0c18514cc4f354d9251e90d165972ec))
- release: prepare OPL DSH v0.2.29 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/fa69c0f7a47baff9ec3e32966d87ea24e06d6916))
- fix: recover interrupted edits and track complete build sources ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/f781c8112f50f2dc588e1fa98e8b92cc5f412e8c))
- fix: preserve complete build metadata generation ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/9b1957f614345684d0bc83264be55ed29eaa750c))
- fix: derive artifact identity from the published source tree ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/5b399375562685c4e36a7a196b28b57428142c10))
- feat: deliver post-PR conversation, runtime and settings improvements ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/e4303e8016d503108263cfdccfd1d99b24446f32))

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制


- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:mechanical -->

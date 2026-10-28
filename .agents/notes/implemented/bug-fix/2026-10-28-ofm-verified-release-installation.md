---
title: OFM 首装与修复使用完整发布包
kind: bug-fix
status: implemented
---

OFM 首装使用固定版本的官方完整 tarball，下载字节须匹配安装器登记的 SHA-256，校验后的原包保存在 profile 的 vendor 目录。官方插件管理器引用该文件执行安装，后续修复沿用本地原包。已有依赖、已安装字节及停用状态仍由插件和用户管理；OPL 重装不自动覆盖。上游版本更新时同时核对发布摘要、完整包的生成资源以及官方 Desktop 隔离安装结果。

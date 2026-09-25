# OPL DSH

基于 DeepSeek 官方桌面，集成 OPL Gateway 与 Codex 协作，提供统一的安装、启动和更新体验。

## 开始使用

从 [下载页面](https://github.com/gaofeng21cn/opl-dsh/releases) 获取适合你电脑的安装包，打开 **OPL DSH**，按引导选择 OPL Gateway 或 DeepSeek 官方登录后即可开始使用。

> 新安装体验正在开发验收，尚未发布。当前已验证的开发基线为 Apple Silicon Mac；Windows 安装及统一自动更新完成验收后才会提供下载。

你只需使用 OPL DSH 这一个入口。官方桌面和增强插件由 OPL DSH 配套管理，无需分别安装、选择版本或更新。

## 可以做什么

- **连接 OPL Gateway**：登录后自动配置模型与备用通道，默认使用 DeepSeek-V4.1-Flash。
- **与 Codex 协作**：Codex 可启动 DSH、派发任务、等待结果并继续工作。
- **使用 DSH 工具**：模型对话、工具执行、工作区和会话由官方 Harness 提供。
- **配置搜索**：使用 Gateway 云端搜索或本地搜索。

Gateway 的账户、余额和连接状态集中在设置中；协议、密钥分组等细节由程序管理。Codex 协作保留 DSH 的权限提示，当前不支持在 Codex 任务停止后主动唤醒它。

## 更新与数据

OPL DSH 以一个产品版本交付。更新同时配套管理桌面依赖和增强功能，保留会话与设置；不要求用户切换到另一个桌面版本，也不提供新旧产品切换入口。

开发状态、安装位置和构建方法见 [开发说明](docs/development.md)。

## 关于

OPL DSH 由 One Person Lab 独立维护，与 DeepSeek 官方无隶属关系。桌面和 Harness 复用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，增强能力通过插件实现。

本项目采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。旧版源码与发布记录保存在 [opl-dsh-legacy](https://github.com/gaofeng21cn/opl-dsh-legacy)。

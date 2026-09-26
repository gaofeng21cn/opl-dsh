# 模型、Harness 与连接

OPL DSH 把“能调用什么”和“怎么运行”分开管理。用户在对话里最终选择的是一个执行组合；连接、模型和 Harness 是组成组合的三个目录层。

## 四层目录

| 层 | 负责什么 | 示例 |
| --- | --- | --- |
| 连接（Connection） | 地址、协议族、认证和健康状态 | OPL Gateway、DeepSeek 官方、自定义 OpenAI 兼容接口 |
| 模型（Model） | 供应方模型 ID、显示名和能力 | `deepseek-flash` / DeepSeek-V4.1-Flash |
| Harness | Agent 循环、工具、权限和会话运行时 | 官方 DSH、Grok Build、Pi |
| 执行组合（Combination） | 把连接、模型、Harness 和权限绑定为一个可选单位 | DeepSeek-V4.1-Flash + DSH |

连接不再直接等同于模型，协议也不再成为用户需要记忆的第二个模型入口。协议属于连接的实现细节；同一连接可以在请求失败时切换到备用协议，但模型选择器仍只显示一个连接来源。

## 用户界面

- 左下角账户菜单只保留“设置”和“账户与登录”。组合不是账户动作，因此不放在这里。
- 设置中的“模型与组合”是唯一的组合管理入口。用户可以查看连接、模型、Harness，修改组合名称、默认组合和权限边界，也可以登记自定义模型和组合。
- OPL Gateway 页面只负责登录、密钥分组、余额和通道健康状态，并提示用户到“模型与组合”管理调用单位，不重复列出模型。
- 官方 DSH 模型选择器只投影可以由原生 DSH 会话直接承载的组合。默认条目显示为“DeepSeek-V4.1-Flash + DSH”，来源分组显示为“OPL Gateway”。
- 外部 ACP Harness（例如 Grok Build）保留在组合目录和组合工作区中。它们拥有自己的上下文、工具和权限，使用“新建组合对话”或 Codex 协作 Skill 启动；不会被伪装成一个已经由 DSH Agent 循环承载的模型。

## 运行与持久化

`execution-catalog.json` 是用户目录的单一入口，保存四组引用：`connections`、`models`、`harnesses` 和 `combinations`。密钥仍由连接自己的账号服务管理，目录只保存 `authRef`。原生 DSH 会话继续由官方 Session API 持久化；外部 Harness 会话由组合服务保存 ACP 会话映射、来源、项目目录、权限边界和每轮结果。

OPL Gateway 的 DeepSeek Messages 通道是默认路径。Codex 分组的 OpenAI 通道只作为输出前故障切换和显式内部路由使用，不进入模型选择器，因此不会再出现两个内容相同的 OPL Gateway 模型分组。

## 扩展规则

新增模型时先登记连接和模型，再选择已安装的 Harness 创建组合。没有适配器的组合可以保存，但必须标记为“未就绪”，不能自动回退到另一个 Harness。新增 Harness 只需要实现组合服务的适配器和权限桥，不需要修改连接或模型目录。

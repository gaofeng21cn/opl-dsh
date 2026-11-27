# OPL Flow 控制塔与桌面底部体验约定

Owner: `opl-dsh`  
State: `active`

本文记录 OPL DSH（`@one-person-lab/dsh-opl`）与 OPL Flow 控制塔对接的轻量边界、Framework v2 与 Studio/DSH 的跨仓红线，以及桌面左下角账户、更新提示与官方原版对齐的产品约定。

---

## 1. OPL Flow 控制塔在 OPL DSH 中的轻量接入边界

OPL DSH 的核心定位是**官方 DeepSeek Harness 的轻量化增强套件**（不强依赖 OPL Framework `opld`，交互界面由 DSH/Cordis 载体自行装配，与 Framework v2 的职责划分以 `one-person-lab/docs/architecture.md` 为准）。在后续集成 OPL Flow 总控/决策看板时，必须遵守以下边界（完整跨端规划见 [opl-flow-workbench-plugin-plan.md](https://github.com/gaofeng21cn/opl-flow/blob/main/docs/opl-flow-workbench-plugin-plan.md)）：

1. **未安装即零存在感**：
   - 仅当本机存在有效绑定的 `~/.config/opl-flow/instance.json` 及可执行 `opl-flow` 控制面时，才在侧栏「更多」条件挂载 `OPL Flow 总控` 入口；
   - 未启用 OPL Flow 的用户完全不可见该入口，不产生任何后台守护进程、常驻轮询或错误提示，也不依赖已删除的 Framework v1 CLI。
2. **只做控制塔，不复制聊天气泡与总账真相**：
   - 前端直接复用标准决策看板数据与动作模型（`dashboard / send / approve / tick / service`），后端通过增强层 Remote 调用 `opl-flow` 的 `opl_app_contribution.py`；
   - 禁止在 `@one-person-lab/dsh-opl` 中维护第二份 Beads/Dolt 状态或第二套对话窗口；用户需要推进具体目标时，直接触发打开/新建 DSH 原生会话（衔接 `opl_dsh_bridge`）。
3. **默认收于侧栏「更多」**：
   - 与 OPL App 一致，默认不常驻固定在主侧栏顶部，避免影响日常单会话体验。

---

## 2. Framework v2 与 Studio / DSH 跨仓红线（防越界契约）

为防止后续维护在不同仓库重复实现或恢复已拍板退役的功能，`opl-dsh` 严格遵守以下与 OPL Framework v2 / OPL Studio 的职责红线：

1. **已正式退役，严禁在 `opl-dsh` 中新增或恢复**：
   - **Homebrew Tap 客户端管理界面**（本仓仅在 CI 发布链路维护自有安装包清单 `Casks/opl-dsh.rb`，不在桌面或 CLI 中提供 Tap 管理面板）；
   - **多安装切换**（Multi-installation switching）；
   - **Action Rollback** 控制面与 UI；
   - **Temporal `provider_*` 面板**。
2. **由 OPL Studio / Bridge 独占，不在 `opl-dsh` 建第二套宿主或绕路封装**：
   - **OPL Link companion host** 由 OPL Studio `opl-host-core` 独占，`opl-dsh` 不实现或接管 companion host；
   - 非微信 `channel_access` 插件过滤等相关桥接修复归属 `opl-framework-bridge`（Wave 2），不在 `opl-dsh` 侧重复过滤或旁路适配。
3. **上游保留面与 DSH 只读原则**：
   - Framework v2 仅保留只读 `opl_base` 版本展示与 `source_refresh`；
   - `opl-dsh` 如需消费外部状态投影（例如 [domain-agent-presets.ts](../src/collaboration/host/domain-agent-presets.ts) 通过 `opl app state --profile fast --json` 读取领域智能体预设），必须保持严格只读，不得调用已删除的 v1 CLI 或引入多安装切换/回滚写操作。

---

## 3. 左下角账户展示与官方风格更新提示

1. **OPL Gateway 账号优先显示用户名称**：
   - 左侧栏底部 `AccountLauncher` 在连接 OPL Gateway 后，优先展示服务端返回的 `account.displayName`（如用户姓名“高峰”），无姓名时再回退至 `account.email` 与通用已登录文案；悬停 `title` 同时保留「姓名 (邮箱)」以便区分多账号。
2. **更新提示对齐官方 `DesktopUpdateIndicator` 位置与样式**：
   - OPL 增强层与执行引擎更新提示不再单独占用 `sidebar.footer.action` 在账号上方额外堆叠一行，而是紧贴左下角账号/设置按钮的**右侧同行**渲染，采用与官方原版 `DesktopUpdateIndicator` 一致的 28px 圆角品牌蓝轻量胶囊样式与下载图标（仅在侧栏展开 `wide` 时展示，收起时不挤占窄栏空间）。
   - 具体检查与触发来源继续沿用既有 `oplUpdates`（OPL 增强层）与 `oplExecution.engine-updates`（执行引擎 CLI），二者并存时弹出菜单分别直达对应设置页。

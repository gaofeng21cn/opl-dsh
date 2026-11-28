# OPL Flow 控制塔与桌面底部体验约定

Owner: `opl-dsh`  
State: `active`

本文记录 OPL DSH（`@one-person-lab/dsh-opl`）与 OPL Flow 控制塔对接的轻量边界、Framework v2 与 Studio/DSH 的跨仓红线，以及桌面左下角账户、更新提示与官方原版对齐的产品约定。

---

## 1. OPL Flow 控制塔在 OPL DSH 中的轻量接入边界

OPL DSH 的核心定位是**官方 DeepSeek Harness 的轻量化增强套件**（不强依赖 OPL Framework `opld`，交互界面由 DSH/Cordis 载体自行装配，与 Framework v2 的职责划分以 `one-person-lab/docs/architecture.md` 为准）。在后续集成 OPL Flow 总控/决策看板时，必须遵守以下边界（完整跨端规划见 [opl-flow-workbench-plugin-plan.md](https://github.com/gaofeng21cn/opl-flow/blob/main/docs/opl-flow-workbench-plugin-plan.md)）：

1. **未安装即零存在感**：
   - 后端通过纯文件系统探测 [src/opl-flow/host/probe.ts](../src/opl-flow/host/probe.ts) 检查 `~/.config/opl-flow/instance.json`（含有效 `instance_root` / `ledger_repo`）与可执行 `opl_app_contribution.py`；探测过程**绝不**拉起子进程、绝不轮询，也不依赖已删除的 Framework v1 CLI。
   - 仅当 `oplFlow.availability()` 返回 `available: true` 时，客户端 [src/opl-flow/client/index.tsx](../src/opl-flow/client/index.tsx) 才按条件注册侧栏入口 `sidebar.panellist`（`id: "opl-flow"`，`order: 34`，中文「OPL Flow 总控」）与 `main`（`key: "opl-flow"`）；未绑定时零槽位、零报错、零后台常驻进程。
2. **只做控制塔，不复制聊天气泡与总账真相**：
   - 后端 [src/opl-flow/host/index.ts](../src/opl-flow/host/index.ts)（`OplFlowService` `@Remote`）直接调用 `opl_app_contribution.py` 消费 `opl-flow.decision.v1` 契约，读看板时显式携带 `{ include_local_navigation: true, host_carrier: "dsh" }`，并在服务端对 `approve` / `service` 变更强制执行 `confirmed === true` 确认保护。
   - 禁止在 `@one-person-lab/dsh-opl` 中维护第二份 Beads/Dolt 状态或第二套聊天窗口；前端 [src/opl-flow/client/OplFlowPanel.tsx](../src/opl-flow/client/OplFlowPanel.tsx) 严格按只读 `jump_mode` 导航：当载体为 `dsh` 且存在 `session_id` 时触发 `ctx.uiWorkspace.openSession(session_id)` 切换原生会话；跨端条目显示 `外部载体` 标记并提供显式 `新建 DSH 会话`（`ctx.uiWorkspace.startSession()`），绝不伪造跨应用焦点切换。
3. **随 DSH 原生「更多 / 取消固定」收放控制**：
   - 与 OPL App 一致保持低干扰收敛定位，同时复用 DSH 原生 `sidebar.panellist` 与「更多 / 取消固定」交互体系，不自建平行固定栏状态。

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
   - `opl-dsh` 如需消费外部状态投影（例如 [domain-agent-presets.ts](../src/collaboration/host/domain-agent-presets.ts)），应优先通过本机 `opld` JSON-RPC（`app.state.get` / `pack.list`）只读读取领域智能体预设（仅保留 `opl app state --profile fast --json` 作为 v1 兼容回退），必须保持严格只读，不得调用已删除的 v1 写命令或引入多安装切换/回滚写操作。

---

## 3. 左下角账户展示与官方风格更新提示

1. **OPL Gateway 账号优先显示用户名称**：
   - 左侧栏底部 `AccountLauncher` 在连接 OPL Gateway 后，优先展示服务端返回的 `account.displayName`（如用户姓名“高峰”），无姓名时再回退至 `account.email` 与通用已登录文案；悬停 `title` 同时保留「姓名 (邮箱)」以便区分多账号。
2. **更新提示对齐官方 `DesktopUpdateIndicator` 位置与样式**：
   - OPL 增强层与执行引擎更新提示不再单独占用 `sidebar.footer.action` 在账号上方额外堆叠一行，而是紧贴左下角账号/设置按钮的**右侧同行**渲染，采用与官方原版 `DesktopUpdateIndicator` 一致的 28px 圆角品牌蓝轻量胶囊样式与下载图标（仅在侧栏展开 `wide` 时展示，收起时不挤占窄栏空间）。
   - 具体检查与触发来源继续沿用既有 `oplUpdates`（OPL 增强层）与 `oplExecution.engine-updates`（执行引擎 CLI），二者并存时弹出菜单分别直达对应设置页。

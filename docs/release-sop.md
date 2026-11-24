# OPL DSH 稳定发布 SOP

本手册是 OPL DSH 稳定发布的执行入口，适用于官方 DeepSeek Harness 与 OPL 增强包的联合稳定 Release（不适用于只构建不公开的本地验证或 nightly）。

触发策略、每日检查、Writer 降级链、联合版本命名、自动更新与历史保留规则统一见[发布约定](release-policy.md)。兼容性脚本的覆盖范围和证据字段见[官方桌面兼容验证](compatibility.md)。命令以当前仓库脚本和 GitHub CLI 实际帮助为准。

## 1. 工作流流转与完成标准

`.github/workflows/stable-release.yml` 每日自动检查主线，按 `prepare` → `package`（macOS arm64）→ `qualify`（macOS arm64 + Windows x64）→ `publish`（Ubuntu）四阶段串行执行：

1. **`prepare`**：运行 `scripts/prepare-shared-release-note-writer.mjs` 与 `scripts/prepare-daily-release.mjs`（仅此 job 与 `publish` 具 `contents: write`）。若主线产品路径或两平台官方 feed 有未发布更新，则递增版本提交 `package.json`/`package-lock.json` 并推送 `opl-dsh-v<版本>` annotated tag（记录冻结的官方版本）；已有未公开 canonical tag 且产品路径与官方 feed 未变时直接续作；仅文档、测试、发布流程或 Cask 变化则跳过。中文发布说明草稿写入 gitignored 的 `dist/release-notes-draft-<版本>.md`，不提交到 `docs/`，并通过工作流 artifact `release-notes` 传递给 `publish` job。
2. **`package`**：固定检出 `source_commit`，执行源码门禁并运行 `npm run package` 与 `npm run release:manifest`，复核实时双平台官方 feed 与冻结版本一致后上传 `release-candidate` artifact。
3. **`qualify`**：从工作流精确修订检出资格运行器到忽略目录，解压同一 `OPL-DSH-Enhancements.zip` 在 macOS arm64 与 Windows x64 独立运行未修改官方桌面验收并上传证据（含 `sourceCommit`、`qualificationRunner.sourceCommit`、`sourceDirty=false`）。若验收确认须改产品代码，保留失败 tag 与证据，递增版本新建 tag 重跑，不覆盖已有候选身份。
4. **`publish`**：运行 `scripts/publish-stable-release.mjs`，下载 `release-candidate`、`release-notes` 与双平台资格证据，再次核对实时官方 feed 并生成 `official-qualification-<版本>.json` 与 `SHA256SUMS`，读取 `dist/release-notes-draft-<版本>.md` 渲染 `dist/release-notes.md`，创建/公开稳定 Release 并逐一下载校验资产与 `releases/latest` 指针；随后仅在 `origin/main` 未移动时更新 `Casks/opl-dsh.rb` 并回读。操作审计保留在 `release-audit` artifact。

一次发布只有在以下事实全部成立时才算完成：

1. 主线候选已冻结，工作区和源提交可追溯；macOS 与 Windows 官方 feed 版本相同，并与构建产物、联合清单和双平台验收证据一致。
2. Host/Client、RPC、模块边界、格式、构建、测试及双平台官方桌面隔离验收全部通过。
3. GitHub Release、canonical tag、五类交付资产、`SHA256SUMS` 与公开正文已发布，`releases/latest` 指向本次 Release，且公开下载资产逐一通过 SHA-256 核对。
4. `Casks/opl-dsh.rb` 已跟随公开增强包摘要并完成回读；历史 Release/tag 按约定保留。

## 2. 版本与权威来源

官方桌面版本以两个更新 feed 为准（`mac-arm64/nightly-mac.yml` 与 `win-x64/nightly.yml`），不以 npm `latest`、网页文案或第三方镜像为准。两份 feed 的 `version`、下载路径与 SHA-512 必须可解析且 `version` 相同；若官方为 RC（如 `0.2.2-rc.5`），Release Note 须保留完整 `-rc` 标识。只读检查命令：

```sh
node --input-type=module -e "import { readOfficialDesktopFeeds } from './scripts/official-desktop-feeds.mjs'; console.log(JSON.stringify(await readOfficialDesktopFeeds(), null, 2))"
gh api 'repos/deepseek-ai/deepseek-harness/releases?per_page=3' --jq '.[] | [.tag_name, .prerelease, .draft, .published_at] | @tsv'
```

OPL 稳定版本使用三段式 SemVer（递增不复用），确保 `package.json`、`package-lock.json`、`Casks/opl-dsh.rb`、Release Note 与 `dist/release-manifest.json`（由 `scripts/create-release-manifest.mjs` 生成并校验双平台 feed 一致）完全对齐。

## 3. 发布前准备

1. **收敛主线**：仅从干净 `main` 开始（`git fetch origin --prune --tags && git switch main && git pull --ff-only origin main && git status --short --branch`）；不覆盖或混入其他未完成任务改动。
2. **对齐官方依赖**：官方 feed 产生新版本时，先将所有 `@deepseek-ai/dsh-*` 开发依赖更新到同一版本并重生成 `package-lock.json`，执行 `npm ci --ignore-scripts`；若官方版本未变，仅在 OPL 代码确有用户可见变更时递增版本。
3. **冻结源码与文档**：README、文档、安装器、测试和源代码必须在构建前完成；`build.mjs` 会将源提交和源树摘要写入 `artifact.json`（`Casks/opl-dsh.rb` 排除在源树摘要之外，留待公开回读后更新）。

## 4. 构建与资格验收

### 4.1 源码门禁

按顺序执行（构建必须先于 artifact 测试与清单生成）：

```sh
npm run generate:rpc
npm run check:rpc
npm run typecheck
npm run check:boundaries
npm run format:check
npm run package
npm test
npm run release:manifest
```

`npm run package` 产出 `dist/OPL-DSH-Enhancements.zip`、`dist/OPL-DSH-Installer-mac-arm64.dmg`、`dist/OPL-DSH-Installer-windows-x64.exe` 与 `dist/OPL DSH 一键安装/artifact.json`。

### 4.2 官方桌面隔离验收

本机使用未修改官方应用与 `--app`（Windows `--download` 会写用户注册表与快捷方式，仅限临时 CI runner），隔离目录须由脚本通过真实 `os.tmpdir()` 创建：

```sh
node scripts/qualify-official-runtime.mjs \
  --app "$HOME/Applications/DeepSeek Harness.app" \
  --payload "dist/OPL DSH 一键安装" \
  --evidence "dist/official-qualification.json"
```

验收 JSON 须满足 `status=passed`、`sourceDirty=false`、双平台 `officialVersion` 与冻结 feed/清单一致、`isolatedInstallation`/Client/runtime/restart/`officialUnmodified` 通过且官方签名与 `app.asar` 摘要未变。本地模拟模型与 API/RPC 通过不代替真实 Gateway、凭据或页面可见性审阅；任一平台未完成桌面验收不得公开 Release。

## 5. 组装发布资产

将证据复制为清单约定文件名并从同一 `dist/` 目录生成摘要：

```sh
cp dist/official-qualification.json dist/official-qualification-<OPL_VERSION>.json
cd dist
shasum -a 256 \
  OPL-DSH-Enhancements.zip \
  OPL-DSH-Installer-mac-arm64.dmg \
  OPL-DSH-Installer-windows-x64.exe \
  release-manifest.json \
  official-qualification-<OPL_VERSION>.json \
  > SHA256SUMS
cd ..
```

发布仅上传这五类资产和 `SHA256SUMS`（仅在能解释验收结论时附带截图）；严禁上传临时 tarball、旧版本产物或含凭据的隔离目录。

## 6. 创建并公开 Release

### 6.1 先固定 tag 与 Release Note 模板

```sh
VERSION=<OPL_VERSION>
TAG="opl-dsh-v$VERSION"
git tag -a "$TAG" -m "OPL DSH v$VERSION"
git push origin main "$TAG"
```

正文写入临时文件并回读核对后再发布（不要重复 `OPL DSH v<版本>` 标题；已发布正文含重复标题时可用 `Normalize release notes` 工作流修复）。正文结构模板：

```markdown
官方 DeepSeek Harness：`A.B.C` · OPL 增强：`X.Y.Z`

本版将官方 DSH 与 OPL 增强作为一套联合稳定版本发布。

### 变更

- <用户可见变更；没有则写“无”>

### 验证

- Host/Client 类型检查、RPC、边界、格式与自动测试：通过
- macOS arm64 官方桌面隔离验收：通过/未通过
- Windows x64 官方桌面隔离验收：通过/未通过

### 已知限制

- <未完成项或平台限制；没有则写“无”>

### 升级

退出 DeepSeek Harness 后运行安装器，或使用 OPL 维护启动入口。安装器和更新器会校验联合清单、官方桌面版本、增强包摘要和逐文件摘要。
```

### 6.2 创建稳定 Release

显式指定稳定与 Latest 标志并使用已有 tag：

```sh
gh release create "$TAG" \
  dist/OPL-DSH-Enhancements.zip \
  dist/OPL-DSH-Installer-mac-arm64.dmg \
  dist/OPL-DSH-Installer-windows-x64.exe \
  dist/release-manifest.json \
  dist/official-qualification-"$VERSION".json \
  dist/SHA256SUMS \
  --verify-tag \
  --title "OPL DSH v$VERSION" \
  --notes-file dist/release-notes.md \
  --latest
```

上传或发布结果未知时先只读回查 Release、tag 与资产，确认未创建前不重试公开变更；若已存在 draft，沿用同一 tag 补齐资产并取消 draft。

## 7. 公开回读与跟随渠道

### 7.1 公开资产回读

```sh
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,publishedAt,assets
curl -fsSL "https://github.com/gaofeng21cn/opl-dsh/releases/latest" -o /dev/null -w '%{url_effective}\n'
mkdir -p /tmp/opl-dsh-release-"$VERSION" && cd /tmp/opl-dsh-release-"$VERSION"
for file in SHA256SUMS release-manifest.json OPL-DSH-Enhancements.zip \
  OPL-DSH-Installer-mac-arm64.dmg OPL-DSH-Installer-windows-x64.exe \
  official-qualification-"$VERSION".json; do
  curl -fsSLO "https://github.com/gaofeng21cn/opl-dsh/releases/download/$TAG/$file"
done
shasum -a 256 -c SHA256SUMS
```

确认 `isDraft=false`、`isPrerelease=false`、`latest` URL 指向 `$TAG` 且所有资产与本地清单逐字节一致。

### 7.2 Homebrew Cask 与双端安装入口

公开回读通过后更新 `Casks/opl-dsh.rb` 的 `version` 与 `sha256`（仅指向已公开 `OPL-DSH-Enhancements.zip`），随后本地检查语法与公开摘要：

```sh
ruby -c Casks/opl-dsh.rb
curl -fsSL "https://github.com/gaofeng21cn/opl-dsh/releases/download/$TAG/OPL-DSH-Enhancements.zip" | shasum -a 256
```

Cask 失败不回滚已公开 Release，单独修复 Cask 后重新回读即可。首次安装入口（`install.sh`/DMG/EXE）与已安装用户的自动更新（退出后 watcher 校验清单与协议版本 1）与官方桌面自身更新保持各自职责边界。

## 8. 失败恢复与可选历史清理

历史 Release 与 tag 默认保留（不在常规发布流程中删除）。仅在用户明确要求并指定范围时，先确认新 Release 已通过公开回读并用 `gh release list --limit 20` / `git ls-remote --tags origin` 核对范围，保存待删元数据后执行 `gh release delete opl-dsh-v<OLD_VERSION> --cleanup-tag --yes`（严禁删除当前 tag、源码提交、Suite 本地 `releases/<suiteSha256>` 或用户 profile/凭据/会话）。

| 断点 | 处理方式 |
| --- | --- |
| 任一官方 feed 失败、版本不一致或冻结版本变化 | 停止准备/打包/发布并记录断点；修复后从主线重新准备或沿同一冻结版本重跑 |
| 源码门禁或测试失败 | 修复源代码/依赖后从源码门禁重跑；不复用旧 artifact |
| package 后发现源代码或文档改变 | 重新构建、生成清单并重新验收；不能只替换 `artifact.json` |
| 官方隔离验收失败 | 定位最深失败检查；macOS/Windows 分开记录，未通过平台不得写成通过 |
| 上传/发布结果未知 | 只读回查 Release、tag、资产和 `latest` 指针；明确已有对象前不重试变更 |
| 资产摘要不一致 | 保留公开 Release，核对损坏/混用原因后按同 tag 修复流程处理 |
| Homebrew 更新或本地用户更新失败 | Release 保持已公开状态并单独恢复 Cask；用户端保留原本地 release/profile 并检查 `enhancement-update.json` |

## 9. 发布记录与快速核对清单

每次发布保留：OPL 版本、官方 DSH 版本、canonical tag、源提交、源码门禁与双平台证据文件名、Release URL / Latest / `SHA256SUMS` 回读结果、macOS/Windows 各自状态与缺口、Homebrew 状态及历史版本保留状态。不用“已构建”“CI 通过”“已排队”代替全平台公开可用。

- **发布前**：双平台 feed 版本相同并已冻结；OPL 版本递增且 lockfile 一致；主线干净且文档源码已冻结；门禁与测试全部通过；双平台隔离验收与 `SHA256SUMS` 已由同一候选生成。
- **发布后**：tag、Release 名称/正文/清单一致；非 draft/prerelease 且 Latest 指向正确；公开下载全部通过 `SHA256SUMS`；Cask 已更新或明确记录未完成；实际证据与限制记录齐全。

# ACP 客户端接入（T3 Code / 其它 ACP 宿主）

> 一句话：**宿主补丁是全局的，提示词注入是 profile 的。** ACP 客户端跑的是另一个 profile，插件不装进去，你得到的就是半套状态——沙箱、审批、文件围栏都放开了，但没有人设注入、没有强化段、没有 probe 回显。
> 首次实测：2026-11-25，DSH Desktop 0.2.2-rc.3（`Resources/app` 已解包，73 applied / 零漂移）+ `dsh-purge-community` 1.7.20 + T3 Code (Nightly) + `acp` profile，macOS 26.2。

<a id="acp-chain"></a>

## 1. 链路事实（先认清这条链，再动手）

| 环节 | 实测值 |
| --- | --- |
| 客户端配置 | T3 Code → provider `DeepSeek Harness` → ACP source `Local command`，Executable `/usr/local/bin/dsh`，Arguments `--profile` / `acp`（落盘在 `~/.t3/userdata/settings.json` 的 `providerInstances.acpRegistry_deepseek_harness.config`） |
| 启动命令 | `/usr/local/bin/dsh --profile acp` |
| `dsh` 是什么 | 指向 `~/.ai/scripts/dsh-launcher.sh`：`Resources/app.asar` 存在就用 asar，否则用 `Resources/app`，最终跑 `Resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` |
| 宿主补丁在哪 | 打在 `Resources/app/dsh/node_modules/@deepseek-ai/**`（同一棵树） |
| profile 目录 | `$DSH_HOME/profiles/acp`（bundles 默认只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-acp-app`，`node_modules` 初始为空） |
| 提示词正文 | `$DSH_HOME/prompt-inject.md`，**全局一份**，桌面版和 ACP 共用 |

**关键推论**：ACP 进程加载的就是桌面版同一份、已被 86 条补丁改写过的源码树。所以 ACP 不需要单独"打补丁"，只需要单独"装插件"。

<a id="acp-layers"></a>

## 2. 五层在 ACP 上的归属

| 层 | 载体 | ACP 是否自动生效 | 需要做什么 |
| --- | --- | --- | --- |
| 宿主补丁（86 条） | `Resources/app/.../@deepseek-ai/**` | **是**（同一棵树） | 无；确认加载源是 `app` 目录而不是 `app.asar` |
| 机械门（沙箱 / 审批 / FS 围栏） | 补丁 + `dsh-base` 默认值 | **是**：base 的 `sandbox-policy.mode` 已被改成 `danger-full-access`、`approval.policy` 为 `never`，`dsh-user-approval` 还有 auto-grant 补丁 | 无；不要为此再写 profile 权限块 |
| 提示词注入 / 强化段 / probe | `dsh-purge-community` 插件（bundle 层） | **否**：空 profile 没有插件 | 见 §3 |
| `unrestricted` 预设 | `dsh-purge-community/presets-plugin` | **否**，且 ACP 没有预设下拉 | 人设只能靠注入正文；不要指望预设 |
| 面板 / 演练台 HTTP 桥 | `dsh-purge-community` 的 client 与 `redteam/ui` | **不适用**：ACP 没有 webServer | 显式 `disabled`，别加未验证的服务别名去"修"它 |

<a id="acp-install"></a>

## 3. 接入步骤（4 步，可回滚）

1. 备份 profile：`cp -R ~/.dsh/profiles/acp ~/.dsh/profiles/.backups/acp-$(date +%Y%m%d-%H%M%S)`。
2. 装插件（固定版本 TGZ，走官方 CLI 转发 pnpm；`bundles` 会自动补上 `dsh-purge-community`，装完仍要肉眼确认一次）：
   ```sh
   dsh plugin --profile acp add \
     https://github.com/atompilot/dsh-purge/releases/download/v1.7.20/dsh-purge-community-1.7.20.tgz
   ```
   `pnpm add` 只加依赖、不加 bundle 行；如果你绕开 CLI 直接 pnpm，必须自己往 `dsh.profile.bundles` 补一条。
3. 关掉 ACP 里永远等不到 `webServer` 的条目，写进 `$DSH_HOME/profiles/acp/cordis.patch.yml`：
   ```yaml
   - id: dsh-purge-redteam-ui
     name: dsh-purge-community/redteam/ui
     disabled: true
   ```
4. 让客户端重开进程（T3 Code 退出重开，或在 provider 页把该 provider 关掉再打开）。**不要重启 DSH Desktop，也不要再点一次「应用」**——宿主补丁已经是最新。

回滚：`dsh plugin --profile acp remove dsh-purge-community` + 删 `bundles` 行；或把 §3.1 的备份整目录拷回。

<a id="acp-verify"></a>

## 4. 验证：两条独立证据，缺一条不算通过

**证据 A — 启动自检**（证明 bundle 能加载、没有 pending）

```sh
dsh --profile acp < /dev/null
```

期望：`exit=0`，**没有任何 `entry did not activate` 警告**。若看到 `dsh-purge-redteam-ui ... pending (waiting for service: webServer)`，说明 §3.3 没写或写错 id。

**证据 B — 端到端注入回显**（证明注入真的到达模型，不是"文件改了"）

1. `purge-community probe new` 拿 nonce；
2. 用**客户端同一条命令**跑一次最小 ACP 会话（NDJSON over stdio：`initialize` → `session/new` → `session/prompt`），把 probe 的 `message` 原样作为 prompt 文本发出去；
3. 回复里出现 `[purge-xxxx]` = 链路通。

实测记录（2026-11-25）：

```
session: acaaab2f-1356-408d-b2e4-8aa130ba233b
STOP: {"stopReason":"end_turn"}
---REPLY---
[purge-7f140d32]
```

**判读规则**：A 绿 B 不绿 → 插件加载了但注入没到（查 `bundle` 是否真的在 `dsh.profile.bundles`、`injectPosition`/`boost` 是否被改）；A 不绿 → 先解决加载，别去调提示词。

<a id="acp-maintenance"></a>

## 5. 维护点（每次 DSH 更新 / 插件升级 / 新增 ACP 客户端都要过一遍）

1. **DSH 桌面更新后 `app.asar` 会回来**，launcher 优先 asar → ACP 静默变回**未打补丁**，客户端不会报任何错。顺序固定为：`dsh-purge-align`（把 asar 让位、重打补丁、重签）→ 重开 ACP 客户端会话。判据：`dsh-purge-align status` 显示「`Resources/app.asar` 不存在（已让位）」且零漂移，或 `ps` 看进程 argv 指向 `Resources/app/dsh/...`。
2. **每个 profile 各装一份插件**：桌面装了 `acp` 里没有。升级时两个 profile 分别 `dsh plugin --profile <name> add <新 TGZ>`，`selfcheck` 只覆盖宿主和当前 profile，**不会**替你检查 acp profile。
3. **新增 ACP 客户端 = 新增一个 profile**：先 `dsh plugin --profile <name> add <TGZ>`，再确认 `bundles`，再跑 §4 的两条证据。不要因为"同一个 `dsh` 命令"就认为自动继承。
4. **新 profile 里第一个 pending 条目通常是 `*-ui` / `*-panel` 类**（等 `webServer`）。做法是显式 `disabled`，并把它写进文档；**不要**加未验证的服务别名（见 compatibility.md §6 的 #127 约束）。
5. **ACP 无面板、无预设下拉**：`unrestricted` 人设不生效，人设只能靠 `prompt-inject.md` 正文。写验收记录时不要写"预设已验证"。
6. **`prompt-inject.md` 是全局文件**：桌面改了对 ACP 同样生效；不要为 ACP 复制第二份，也不要让脚本按 profile 覆盖它。
7. **ACP 的结论不要当桌面证据、反之亦然**：补丁归属相同，但注入层、UI、预设、工具面不同，验收记录分栏写。
8. **卸载/回滚路径**要能一眼看懂：删插件 + 删 bundle 行 + 恢复备份目录，三步都要在交付说明里给出。

<a id="acp-regression"></a>

## 6. 回归检查表（可直接照抄进 issue / 交付说明）

- [ ] `dsh-purge-align status`：加载源 `app`、零漂移、applied 数符合当版分母
- [ ] `dsh --profile acp < /dev/null` → `exit=0` 且无 `did not activate`
- [ ] `purge-community probe new` → 经 ACP 会话回显 nonce
- [ ] `~/.dsh/profiles/acp/package.json`：`dependencies` 与 `dsh.profile.bundles` 都含 `dsh-purge-community`
- [ ] `cordis.patch.yml` 里 `dsh-purge-redteam-ui` 为 `disabled: true`
- [ ] 客户端侧确认 provider 仍指向 `/usr/local/bin/dsh --profile acp`（升级/重装客户端可能丢配置）
- [ ] 用一个会触发机械门的动作验证沙箱（如读取工作区外文件），确认没有弹审批

<a id="acp-unknown"></a>

## 7. 未知与不适用（写报告时照抄）

- **其它 ACP 客户端**（Zed、其它编辑器 ACP 集成）：未实测。链路相同不代表行为相同，尤其权限请求与会话生命周期。
- **ACP 下的面板 / 演练台 / 红队 HTTP 桥**：不适用（无 `webServer`）；不要为了"补齐"而在 ACP profile 里引入 web 服务。
- **ACP 下的交互式审批 / 等待回答语义**：未验证。宿主补丁把审批改成 auto-grant，但这不等于 ACP 客户端侧的权限 UI 会正确表现。
- **Windows 上的 ACP 接入**：未实测。
- **`dsh.acp` 的 model/provider 默认值**来自 `dsh-acp-app` 的 bundle patch（`deepseek-official` / `deepseek-v4-flash`），客户端可以在会话里覆盖；不要把客户端选的模型写进兼容结论。

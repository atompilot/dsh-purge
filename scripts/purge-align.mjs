#!/usr/bin/env node
/**
 * purge-align — 让宿主补丁真的被加载（加载路径对齐），然后打补丁、重签、校验。
 *
 * 背景：DSH 桌面版 Electron 优先加载 `Resources/app.asar`，而补丁写在 `Resources/app/`。
 * 两者不一致时补丁全空转，状态页却显示"已打"。本脚本把 `Resources/app` 变成唯一加载源。
 *
 * 用法：
 *   purge-align                 对齐 + 打补丁 + 重签 + 校验（幂等，可反复跑）
 *   purge-align status          只看状态（不写盘）
 *   purge-align revert          还原成 asar 加载（补丁留在目录里，仍会重签）
 *   purge-align apply           只重新打补丁（假设加载源已对齐）
 *   purge-align sign            只重签
 *
 * 常用参数：
 *   --app=PATH        应用路径，默认 $DSH_APP 或 /Applications/DeepSeek Harness.app
 *   --profile=NAME    找插件用的 profile，默认 $PURGE_PROFILE 或 desktop（macOS）/ web（Linux）
 *   --home=PATH       DSH 数据目录，默认 $DSH_HOME 或 ~/.dsh
 *   --plugin=PATH     指定已安装的插件目录（默认按 profile 推导）
 *   --no-sign         跳过 ad-hoc 重签（只在明确知道后果时用）
 *   --dry-run         只打印计划，不写盘
 *   --json            机器可读输出
 *   --allow-running   宿主进程在跑也继续（可能解包失败/写坏，慎用）
 *   --recover-legacy  从 app.asar 归档里取回"被污染"的 .dshpurge.bak（1.7.24 升级用）
 *
 * 设计约束（与仓库其它部分一致）：
 * - 只改文件、不猜版本：宿主目录必须能自证（package.json + @deepseek-ai）。
 * - 幂等：重复跑收敛成「已经对齐」，不重复解包。
 * - 可回滚：解包失败走 restoreExtractedDir；归档原样留在 app.asar.bak。
 * - 失败要报清楚，不把「界面绿灯」当证据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const arg of argv) {
  if (arg.startsWith("--")) {
    const [k, ...rest] = arg.slice(2).split("=");
    flags.set(k, rest.length ? rest.join("=") : true);
  } else positional.push(arg);
}
const has = (name) => flags.has(name);
const val = (name, fallback = "") => (typeof flags.get(name) === "string" ? flags.get(name) : fallback);
const cmd = (positional[0] || "align").toLowerCase();
const wantJson = has("json");
const dryRun = has("dry-run");
const skipSign = has("no-sign") || process.platform !== "darwin";

const log = (...a) => { if (!wantJson) console.log(...a); };
const warn = (...a) => { if (!wantJson) console.warn(...a); };
const emit = (value) => { if (wantJson) console.log(JSON.stringify(value, null, 2)); };
const fail = (message, code = 1) => {
  emit({ ok: false, code, error: message });
  if (!wantJson) console.error(`✗ ${message}`);
  process.exit(code);
};

const DEFAULT_APP = "/Applications/DeepSeek Harness.app";
const APP = path.resolve(val("app", process.env.DSH_APP || DEFAULT_APP));
const RES = path.join(APP, "Contents", "Resources");
const ASAR = path.join(RES, "app.asar");
const BAK = `${ASAR}.bak`;
const APPDIR = path.join(RES, "app");
const HOME = path.resolve(val("home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
// 这里的 profile 只用来找"已安装的插件"，不是宿主的运行 profile：
// ACP/CLI 会话里 DSH_PROFILE 可能是别的值，跟着它走会挑错插件。
const PROFILE = val("profile", process.env.PURGE_PROFILE || (process.platform === "darwin" ? "desktop" : "web"));
const PROFILE_DIR = path.join(HOME, "profiles", PROFILE);
const BACKUP_ROOT = path.join(os.homedir(), "Library", "Application Support", "dsh-purge");

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// Electron 会给 node:fs 装上 asar 补丁：`app.asar` 这种路径会被当成"虚拟目录"，
// accessSync/statSync 拿到的是 ENOENT / 0 字节。归档相关的一切都用插件自己的
// original-fs 接口（asarArchiveIsFile / diskFs），别用裸 fs 判存在。
let archiveApi = null;
const asarIsFile = (p) => (archiveApi ? archiveApi.asarArchiveIsFile(p) : exists(p));
const diskFsNow = () => (archiveApi ? archiveApi.diskFs() : fs);

function runningHostPids() {
  if (process.platform !== "darwin") return [];
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", `${APP}/Contents/MacOS/`], { encoding: "utf8", timeout: 5000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** 宿主版本优先读解包目录；没解包时退回 Info.plist（那是 Desktop 版本，仅作提示）。 */
function hostVersion() {
  try { return readJson(path.join(APPDIR, "package.json")).version || "?"; } catch { /* 继续 */ }
  try {
    const out = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(APP, "Contents", "Info.plist")], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return `${out.trim()} (Desktop)`;
  } catch { return "?"; }
}

/** 插件优先用已安装的那份（profile 里），其次用本仓库自身。 */
async function loadPlugin() {
  const candidates = [];
  if (val("plugin")) candidates.push(path.resolve(val("plugin")));
  candidates.push(path.join(PROFILE_DIR, "node_modules", "dsh-purge-community"));
  candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."));
  for (const dir of candidates) {
    if (!exists(path.join(dir, "lib", "core.js"))) continue;
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg.name !== "dsh-purge-community") continue;
    const core = await import(path.join(dir, "lib", "core.js"));
    const ext = await import(path.join(dir, "lib", "extract-asar.js"));
    return { dir, version: pkg.version, core, ext };
  }
  fail(`找不到 dsh-purge-community（试过 ${candidates.join("、")}）。先装插件，或用 --plugin= 指定。`, 3);
  return null;
}

/** 宿主里真正的 @deepseek-ai 根：优先 app/dsh 下的那份（cli 入口实际加载的树）。 */
function aiBaseUnder(dir) {
  for (const candidate of [path.join(dir, "dsh", "node_modules", "@deepseek-ai"), path.join(dir, "node_modules", "@deepseek-ai")]) {
    if (isDir(candidate)) return candidate;
  }
  return "";
}

// 逐条状态 + 旧版权限迁移。legacyPermissions 不是补丁漂移：它是"磁盘上还留着 1.7.24 下线的
// 那 14 条权限改动，需要还原"，还原不了时引擎会指名文件并保留现场（不能当绿灯，也不能当漂移）。
// pending = 引擎判定"还有活没干"（lib/reapply.js 也是这么用的），不能当成功。
const BAD_STATES = new Set(["drifted", "partial", "missing_file", "unmatched", "pending"]);
async function tally(core, aiBase) {
  const detail = await core.patchStatusDetail(aiBase, undefined, { surface: "desktop", dshHome: HOME });
  const status = detail.status || {};
  const counts = {};
  const bad = [];
  for (const [id, value] of Object.entries(status)) {
    if (id === "legacyPermissions") continue;
    counts[value] = (counts[value] || 0) + 1;
    if (BAD_STATES.has(value)) bad.push([id, value]);
  }
  const legacy = status.legacyPermissions ? { status: status.legacyPermissions, message: detail.legacyPermissions?.message || "" } : null;
  const total = Object.keys(status).filter((id) => id !== "legacyPermissions").length;
  return { status, counts, bad, legacy, total };
}

function collectPatchedFiles(aiBase, extra = []) {
  // 两个来源合起来：① 本次 apply 报告里的落盘路径（首次安装没有 .dshpurge.bak）；
  // ② 历史遗留的 .dshpurge.bak 兄弟文件（幂等重跑、老机器）。任一来源都够用。
  const files = new Set();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "node_modules") walk(full); continue; }
      if (ent.name.endsWith(".dshpurge.bak")) files.add(full.slice(0, -".dshpurge.bak".length));
    }
  };
  for (const root of [aiBase, path.join(APPDIR, "lib")]) {
    if (isDir(root)) { try { walk(root); } catch { /* 读不到就不算语法错误 */ } }
  }
  for (const file of extra) if (file && isDir(path.dirname(file)) && exists(file)) files.add(file);
  return [...files];
}

function syntaxReport(aiBase, extra = []) {
  const files = collectPatchedFiles(aiBase, extra);
  const js = files.filter((f) => /\.(m?js|cjs)$/.test(f));
  const broken = [];
  // SourceTextModule 需要 --experimental-vm-modules。没带这个 flag 时退回 `--check` 子进程：
  // 两者都只解析不执行，别因为缺 flag 就跳过校验（写坏了文件，宿主下次启动直接起不来）。
  const hasModuleParser = typeof vm.SourceTextModule === "function";
  for (const file of js) {
    try {
      if (hasModuleParser) new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file });
      else execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    } catch (error) {
      const detail = String((error && (error.stderr || error.message)) || error).trim().split("\n").slice(0, 3).join(" ");
      broken.push({ file, error: detail.slice(0, 300) });
    }
  }
  return { js: js.length, broken, parser: hasModuleParser ? "vm.SourceTextModule" : "node --check" };
}

function reSign() {
  if (process.platform !== "darwin") return { ok: true, skipped: true };
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-",
      "--preserve-metadata=identifier,entitlements,flags", "--timestamp=none", APP],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP], { stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
    return { ok: true };
  } catch (error) {
    const detail = String((error && (error.stderr || error.message)) || error).trim().slice(0, 400);
    return { ok: false, error: detail };
  }
}

const state = (ext = null) => ({
  app: APP,
  appExists: isDir(APP),
  resources: RES,
  appDir: APPDIR,
  appDirPresent: isDir(APPDIR),
  asar: ASAR,
  asarPresent: ext ? ext.asarArchiveIsFile(ASAR) : exists(ASAR),
  asarBackup: BAK,
  asarBackupPresent: ext ? ext.asarArchiveIsFile(BAK) : exists(BAK),
  hostVersion: hostVersion(),
  profile: PROFILE,
  profileDir: PROFILE_DIR,
  home: HOME,
  runningPids: runningHostPids(),
});

async function doStatus({ quiet = false } = {}) {
  const plugin = await loadPlugin();
  archiveApi = plugin.ext;
  const info = state(plugin.ext);
  const aiBase = aiBaseUnder(APPDIR);
  const report = aiBase ? await tally(plugin.core, aiBase) : null;
  const summary = {
    ok: Boolean(aiBase) && !info.asarPresent && Boolean(report) && report.bad.length === 0,
    plugin: { dir: plugin.dir, version: plugin.version },
    ...info,
    aiBase,
    loadingSource: info.asarPresent ? "app.asar (补丁不生效)" : info.appDirPresent ? "app (补丁生效)" : "missing",
    patches: report ? { total: report.total, counts: report.counts, drift: report.bad.map(([id, s]) => `#${id}:${s}`) } : null,
    legacyPermissions: report?.legacy || null,
  };
  if (!quiet) {
    log(`宿主        ${info.app}（${summary.hostVersion}）`);
    log(`插件        ${plugin.version}  ${plugin.dir}`);
    log(`profile     ${PROFILE}  ${PROFILE_DIR}`);
    log(`Resources/app        ${info.appDirPresent ? "存在" : "缺失"}`);
    log(`Resources/app.asar   ${info.asarPresent ? "存在  ← Electron 优先加载它" : "不存在"}`);
    log(`Resources/app.asar.bak ${info.asarBackupPresent ? "存在（已让位）" : "不存在"}`);
    log(`⇒ 加载源：${summary.loadingSource}`);
    if (aiBase) log(`⇒ 宿主树：${aiBase}`);
    if (report) {
      const drift = report.bad.length ? ` | 异常 ${report.bad.map(([id, s]) => `#${id}:${s}`).join(",")}` : " | 零漂移";
      log(`补丁        ${JSON.stringify(report.counts)} 共 ${report.total} 条${drift}`);
      if (report.legacy) {
        warn(`旧版权限    ${report.legacy.status}：${report.legacy.message.split("\n")[0]}`);
        warn("            这是 1.7.24 下线的那 14 条留下的现场；purge-align align 会尝试还原，还原不了就按提示处理，不要手动删 .dshpurge.bak。");
      }
    }
    if (info.runningPids.length) warn(`注意        宿主进程在运行（pid ${info.runningPids.join(",")}），改动要退出后才会加载`);
  }
  emit(summary);
  return summary;
}

/**
 * 旧版权限迁移的失败会把文件名和原因放在一条 message 里（lib/retired-permissions.mjs）：
 *   "Legacy permission migration: <file>: <reason>"
 * 只有"备份本身不干净"这一类能靠归档修复；其它原因一律不猜。
 */
const REPAIRABLE = [
  "backup already contains a retired permission marker",
  "backup contains historical output without a native reference",
];
export function parseLegacyFailure(message) {
  const text = String(message || "").split("\n")[0];
  const m = /^Legacy permission migration: (.+?): (.+)$/.exec(text);
  if (!m) return null;
  const [, file, reason] = m;
  return { file, reason, repairable: REPAIRABLE.includes(reason) };
}

/**
 * 用同版本官方归档里的那份原文，替换被污染的单文件备份，然后再让引擎自己去还原。
 * 前提是 app.asar（或其 .bak）还在——它就是这台机器上唯一的"干净来源"。
 */
async function refreshPollutedBackup(plugin, file, archive, cache) {
  const { ext } = plugin;
  const rel = path.relative(APPDIR, file);
  if (rel.startsWith("..")) throw new Error(`${file} 不在 ${APPDIR} 下，拒绝从归档取值`);
  if (!cache.dir) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-archive-"));
    log(`  解包归档取原文（${archive}）→ ${dir}，只取一个文件，取完即删`);
    ext.extractAsar(archive, dir);
    cache.dir = dir;
  }
  const pristine = path.join(cache.dir, rel);
  if (!exists(pristine)) throw new Error(`归档里没有 ${rel}`);
  const bak = `${file}.dshpurge.bak`;
  fs.copyFileSync(pristine, bak);
  return { file, bak, bytes: fs.statSync(bak).size };
}

async function doAlign() {
  const plugin = await loadPlugin();
  const { core, ext, version } = plugin;
  const pids = runningHostPids();
  if (pids.length && !has("allow-running") && !dryRun) {
    fail(`宿主进程在运行（pid ${pids.join(",")}）。先完整退出 DSH（⌘Q，不是关窗口）再跑；确认风险后用 --allow-running。`, 3);
  }
  if (!isDir(APP)) fail(`找不到应用：${APP}（用 --app= 指定）`, 3);
  log(`宿主        ${APP}（${hostVersion()}）`);
  log(`插件        ${version}  ${plugin.dir}`);

  let opened = null;
  const sealed = core.sealedAsarHandoff ? core.sealedAsarHandoff() : null;
  archiveApi = ext;
  const archivePresent = ext.asarArchiveIsFile(ASAR);
  if (!archivePresent && isDir(APPDIR)) {
    log("→ asar 已让位，加载源就是 app 目录，跳过解包");
  } else if (!archivePresent) {
    fail(`既没有 ${ASAR}，也没有 ${APPDIR}。检查 --app 是否指向真正的 DeepSeek Harness.app`, 3);
  } else if (dryRun) {
    const ident = ext.asarFileIdentity(ASAR);
    log(`→ [dry-run] 会解包 ${ASAR}（${ident ? ident.size : "?"} 字节）→ ${APPDIR}，再把它的 @deepseek-ai 打上补丁`);
  } else if (!sealed) {
    // 宿主身份识别不上（非官方包名/exe 不匹配）时，仍然按"归档 + 目录"这一层事实自己解：
    // 只认 --app 指的这个 Resources，绝不回头去挑机器上另一份安装。
    log("→ 没识别出官方密封包身份，按归档事实自行解包（只动 --app 指定的这份）");
    fs.mkdirSync(path.join(BACKUP_ROOT, "asar-backup"), { recursive: true });
    const ident = ext.asarFileIdentity(ASAR);
    const backup = path.join(BACKUP_ROOT, "asar-backup", `app.asar-${ident ? ident.size : "unknown"}-${new Date().toISOString().slice(0, 10)}`);
    if (!exists(backup)) diskFsNow().copyFileSync(ASAR, backup);
    let side = null;
    let prev = "";
    try {
      side = ext.extractAsarToSide(ASAR, APPDIR);
      ext.overlayAsarUnpacked(ASAR, side.next);
      ext.verifyStagedAsar(ASAR, side.next);
      if (!aiBaseUnder(side.next)) throw new Error(`解开的目录里没有 @deepseek-ai（${side.next}）`);
      const committed = ext.commitExtractedDir(APPDIR, side.next);
      prev = committed.prev || "";
      side = null;
      log(`  解包完成 → ${APPDIR}`);
    } catch (error) {
      if (side?.next && !error.keepStage) { try { fs.rmSync(side.next, { recursive: true, force: true }); } catch { /* 半成品留着不影响旧目录 */ } }
      try { if (prev) ext.restoreExtractedDir(APPDIR, prev); } catch { /* 旧目录仍在 prev */ }
      fail(`解包失败：${error.message}`, 1);
    }
  } else {
    log("→ 解包 app.asar → Resources/app（先备份归档，失败自动放回旧目录）");
    fs.mkdirSync(path.join(BACKUP_ROOT, "asar-backup"), { recursive: true });
    const ident = ext.asarFileIdentity(ASAR);
    const stampName = `app.asar-${ident ? ident.size : "unknown"}-${new Date().toISOString().slice(0, 10)}`;
    const backup = path.join(BACKUP_ROOT, "asar-backup", stampName);
    if (!exists(backup)) {
      diskFsNow().copyFileSync(ASAR, backup);
      log(`  已备份归档 → ${backup}`);
    }
    opened = await core.openSealedDesktopHost({ forApply: true });
    log(`  解包完成${opened?.extracted ? "" : "（复用已有目录）"} → ${opened?.appDir || APPDIR}`);
  }

  // 只认 --app 这份安装里的树：发现不了就报错，绝不回退到"机器上另一份 DSH"。
  const aiBase = (opened && opened.aiBase) || aiBaseUnder(APPDIR);
  if (!aiBase) fail(`app 目录里没有 @deepseek-ai，停止（目录：${APPDIR}）。确认 --app 指向真正的 DeepSeek Harness.app`, 1);

  // 1.7.24 下线了 14 条权限补丁：老机器上那批 .dshpurge.bak 可能是"打过补丁的备份"，
  // 引擎会拒绝自动还原并指名文件。--recover-legacy 从同版本归档里取回原文备份再继续。
  const archiveForRecovery = asarIsFile(BAK) ? BAK : asarIsFile(ASAR) ? ASAR : "";
  if (has("recover-legacy")) {
    const cache = {};
    // 引擎一次只报一个文件；一台从 ≤1.7.23 升上来的机器上通常有十几个。
    for (let round = 0; round < 64; round += 1) {
      const probe = await tally(core, aiBase);
      if (!probe.legacy || probe.legacy.status !== "unmatched") break;
      const failure = parseLegacyFailure(probe.legacy.message);
      if (!failure || !failure.repairable) {
        warn(`  旧版权限无法自动修复：${probe.legacy.message.split("\n")[0]}`);
        break;
      }
      if (!archiveForRecovery) fail("要修旧版权限备份，但找不到 app.asar 或 app.asar.bak（官方归档）", 1);
      if (dryRun) { log(`  [dry-run] 会用归档原文刷新 ${path.basename(failure.file)}.dshpurge.bak`); break; }
      log(`→ 刷新被污染的备份：${failure.file}`);
      const done = await refreshPollutedBackup(plugin, failure.file, archiveForRecovery, cache);
      log(`  ✓ 已用归档原文覆盖 ${done.bak}（${done.bytes} 字节）`);
    }
    if (cache.dir) { try { fs.rmSync(cache.dir, { recursive: true, force: true }); } catch { /* 临时目录留着不影响后续 */ } }
  }

  log("→ 应用补丁");
  let applied = null;
  let appliedPaths = [];
  if (dryRun) {
    const report = await tally(core, aiBase);
    log(`  [dry-run] 当前状态：${JSON.stringify(report.counts)} 共 ${report.total} 条`);
  } else {
    let results;
    try { results = await core.applyPatches(aiBase, undefined, { surface: "desktop" }); }
    catch (error) {
      const failure = parseLegacyFailure(error && error.message);
      const hint = failure
        ? `\n  这条是 1.7.24 下线的权限补丁留下的备份现场。${failure.repairable ? "加 --recover-legacy 从官方归档取回原文备份后重跑。" : "按提示核对文件现场，不要手动删 .dshpurge.bak。"}`
        : "";
      fail(`${error && error.message ? error.message : error}${hint}`, 1);
    }
    applied = {};
    for (const row of results) {
      applied[row.status] = (applied[row.status] || 0) + 1;
      if (row.path) appliedPaths.push(row.path);
    }
    log(`  apply：${JSON.stringify(applied)}  共 ${results.length} 条`);
    const failed = results.filter((row) => ["failed", "error"].includes(row.status));
    if (failed.length) fail(`有补丁失败：${JSON.stringify(failed.slice(0, 3))}。归档仍原样在 ${BAK || ASAR}`, 1);
  }

  const report = await tally(core, aiBase);
  log(`  状态：${JSON.stringify(report.counts)} 共 ${report.total} 条`);
  if (report.bad.length) fail(`补丁漂移：${report.bad.map(([id, s]) => `#${id}:${s}`).join(", ")}`, 2);
  log("  ✓ 零漂移");
  if (report.legacy) {
    warn(`  旧版权限：${report.legacy.status === "pending" ? "待还原" : "无法自动还原"} → ${report.legacy.message.split("\n")[0]}`);
    warn("  这条不是补丁漂移。按提示核对文件现场；不要手动删 .dshpurge.bak，也不要把它当作已生效。");
  }

  if (!dryRun) {
    const touched = Array.isArray(appliedPaths) ? appliedPaths : [];
    const syn = syntaxReport(aiBase, touched);
    log(`  语法：${syn.js} 个改写文件检查完毕（${syn.parser}），错误 ${syn.broken.length}`);
    if (syn.broken.length) fail(`改写后有语法错误：${syn.broken[0].file} ${syn.broken[0].error}`, 1);
  }

  if (asarIsFile(ASAR) && !dryRun) {
    const moved = ext.renameAsarAside(ASAR);
    log(moved.renamed ? `  ✓ asar 让位 → ${moved.bak}` : "  ! asar 让位失败（被占用？先退出宿主再重试）");
    if (moved.renamed) {
      const ident = ext.asarFileIdentity(BAK);
      if (ident && typeof core.writeUnpackedAsarStamp === "function") core.writeUnpackedAsarStamp(ident);
    }
  }

  let signed = { ok: true, skipped: true };
  if (dryRun) log("  [dry-run] 会做 ad-hoc 重签");
  else if (skipSign) log("  - 跳过重签（--no-sign 或非 macOS）");
  else {
    log("→ ad-hoc 重签（改了 bundle 内容后封印失效，不重签 macOS 会报 damaged）");
    signed = reSign();
    log(signed.ok ? "  ✓ 签名校验通过" : `  ! 重签失败：${signed.error}`);
  }
  if (!dryRun && !signed.ok) fail(`重签失败：${signed.error}。可单独重试：purge-align sign`, 1);

  const summary = await doStatus({ quiet: true });
  const result = { ok: summary.ok, applied, signed, ...summary, dryRun };
  if (!wantJson) {
    log("");
    if (dryRun) log("↑ 以上是计划，没有写盘。");
    else log(summary.ok ? "✓ 对齐完成。重启 DSH 生效。" : "⚠ 对齐跑完了，但加载源还不是 app 目录，按上面的告警处理。");
    log(`回滚：purge-align revert（把 ${BAK} 放回去）`);
  }
  emit(result);
  process.exitCode = dryRun || summary.ok ? 0 : 2;
}

async function doRevert() {
  archiveApi = (await loadPlugin()).ext;
  if (!asarIsFile(BAK)) fail(`没有 ${BAK} 可还原`, 1);
  if (runningHostPids().length && !has("allow-running")) fail("宿主进程在运行，先退出再还原", 3);
  if (dryRun) { log(`[dry-run] 会把 ${BAK} 放回 ${ASAR}`); return; }
  const disk = diskFsNow();
  if (asarIsFile(ASAR)) disk.rmSync(ASAR, { force: true });
  disk.renameSync(BAK, ASAR);
  const signed = reSign();
  log(signed.ok ? "✓ 已还原为 asar 加载，并重签通过" : `✓ 已还原为 asar 加载，但重签失败：${signed.error}`);
  emit({ ok: true, reverted: true, signed });
  if (!signed.ok) process.exitCode = 1;
}

async function doApplyOnly() {
  const plugin = await loadPlugin();
  const aiBase = aiBaseUnder(APPDIR);
  if (!aiBase) fail("没有 app 目录（先跑 purge-align 解包）", 1);
  if (dryRun) { log("[dry-run] 只打印不写盘"); }
  const results = dryRun ? [] : await plugin.core.applyPatches(aiBase, undefined, { surface: "desktop" });
  const applied = {};
  for (const row of results) applied[row.status] = (applied[row.status] || 0) + 1;
  const report = await tally(plugin.core, aiBase);
  log(`apply：${JSON.stringify(applied)}；状态：${JSON.stringify(report.counts)}`);
  emit({ ok: report.bad.length === 0, applied, counts: report.counts, drift: report.bad.map(([id, s]) => `#${id}:${s}`) });
  if (report.bad.length) process.exitCode = 2;
}

function doSignOnly() {
  const signed = reSign();
  emit({ ok: signed.ok, signed });
  if (!signed.ok) fail(`重签失败：${signed.error}`, 1);
  log("✓ 重签完成");
}

const main = async () => {
  if (has("help") || cmd === "help") {
    console.log("用法：purge-align [align|status|revert|apply|sign] [选项]\n"
      + "  --app=PATH       应用路径（默认 $DSH_APP 或 /Applications/DeepSeek Harness.app）\n"
      + "  --profile=NAME   找插件用的 profile（默认 $PURGE_PROFILE 或 desktop/web）\n"
      + "  --home=PATH      DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）\n"
      + "  --plugin=PATH    指定已安装的插件目录\n"
      + "  --no-sign        跳过 ad-hoc 重签\n"
      + "  --dry-run        只打印计划\n"
      + "  --json           机器可读输出\n"
      + "  --allow-running  宿主在跑也继续（可能写坏，慎用）\n"
      + "  --recover-legacy 用官方归档原文修复被污染的 .dshpurge.bak（1.7.24 升级用）");
    return;
  }
  if (cmd === "status") { const s = await doStatus(); process.exitCode = s.ok ? 0 : 2; return; }
  if (cmd === "revert") return doRevert();
  if (cmd === "apply") return doApplyOnly();
  if (cmd === "sign") return doSignOnly();
  if (cmd !== "align") fail(`未知命令：${cmd}（align / status / revert / apply / sign）`, 3);
  return doAlign();
};

// 被 import 时（测试/其它脚本）不要执行动作，只导出工具函数。
// 比较必须走 realpath：/tmp → /private/tmp 这类符号链接会让"路径相等"判断失效，
// 结果是脚本一声不响地什么都不做还返回 0 —— 比报错危险得多。
function invokedDirectly() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(invoked) === real(fileURLToPath(import.meta.url));
}
if (invokedDirectly()) {
  main().catch((error) => fail(error && error.message ? error.message : String(error)));
}

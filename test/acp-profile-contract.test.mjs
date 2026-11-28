// ACP 接入是"宿主补丁全局、注入层按 profile"的第二种形态：
// 文档一旦漂移，下一个人就会按桌面版经验去接 ACP，得到"门拆了、人没换"的半套状态。
// 这里钉住四处契约：manifest 的 profile 声明、ACP 页面的可复制命令与维护点、
// 排障锚点、以及三个入口文档互相引用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(read('package.json'));
const acpDoc = read('docs/maintenance-acp.md');
const troubleshooting = read('docs/troubleshooting.md');
const compatibility = read('docs/compatibility.md');
const agents = read('AGENTS.md');

test('manifest declares the acp profile without dropping desktop or web', () => {
  const profiles = pkg.dsh.compatibility.profiles;
  assert.ok(Array.isArray(profiles));
  for (const name of ['desktop', 'web', 'acp']) assert.ok(profiles.includes(name), name);
  for (const name of profiles) assert.match(name, /^[a-z][a-z0-9-]*$/);
});

test('acp page carries the copyable install command and the profile-local bundle rule', () => {
  for (const needle of [
    'dsh plugin --profile acp add',
    'dsh-purge-community-',
    'dsh.profile.bundles',
    'dsh-purge-redteam-ui',
    'disabled: true',
    '/usr/local/bin/dsh',
    'prompt-inject.md',
  ]) assert.ok(acpDoc.includes(needle), `docs/maintenance-acp.md 缺少：${needle}`);
});

test('acp page keeps both verification evidences and the unknown boundaries', () => {
  // A: 启动自检；B: 端到端 probe 回显。少一条就等于把"文件改了"当成"注入到了"。
  for (const needle of ['dsh --profile acp < /dev/null', 'exit=0', 'did not activate', 'probe new', 'nonce'])
    assert.ok(acpDoc.includes(needle), `docs/maintenance-acp.md 缺少验证要素：${needle}`);
  for (const needle of ['未实测', '不适用', 'webServer'])
    assert.ok(acpDoc.includes(needle), `docs/maintenance-acp.md 缺少边界声明：${needle}`);
});

test('acp page keeps the post-update maintenance points', () => {
  // 后续维护点是最容易在重构文档时丢掉的一段：每一条都对应一次真实踩坑。
  for (const needle of [
    '`app.asar` 会回来',
    'dsh-purge-align',
    '每个 profile 各装一份插件',
    'selfcheck` 只覆盖宿主',
    '无预设下拉',
    '全局一份',
  ]) assert.ok(acpDoc.includes(needle), `docs/maintenance-acp.md 缺少维护点：${needle}`);
});

test('troubleshooting exposes a stable #t-acp anchor and links the acp page', () => {
  assert.ok(troubleshooting.includes('<a id="t-acp"></a>'), '缺少 #t-acp 锚点');
  assert.ok(troubleshooting.includes('maintenance-acp.md'), '排障页未链接 ACP 页面');
  assert.ok(troubleshooting.includes('](#t-acp)'), '症状总表未指向 #t-acp');
});

test('entry docs agree on where acp guidance lives', () => {
  assert.ok(compatibility.includes('acp'), 'compatibility.md 未提 acp profile');
  assert.ok(compatibility.includes('maintenance-acp.md'), 'compatibility.md 未链接 ACP 页面');
  assert.ok(agents.includes('docs/maintenance-acp.md'), 'AGENTS.md 未链接 ACP 页面');
  assert.ok(agents.includes('--profile acp'), 'AGENTS.md 缺少 acp profile 启动形态');
});

test('README surfaces and the maintenance doc carry the same acp claim', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('`desktop` / `web` / `acp`'), 'README 未声明 acp profile');
  assert.ok(readme.includes('maintenance-acp.md'), 'README 未链接 ACP 页面');
  assert.equal(read('README.zh-CN.md'), readme);
  assert.ok(read('docs/MAINTENANCE.md').includes('maintenance-acp.md'), 'MAINTENANCE 未链接 ACP 页面');
  assert.ok(read('docs/README.en.md').includes('maintenance-acp.md'), 'README.en 未链接 ACP 页面');
});

test('archive keeps the acp record and the release draft stays a draft', () => {
  const archive = read('docs/maintenance-archive.md');
  assert.ok(archive.includes('<a id="v1-7-20-acp"></a>'), '档案缺少 ACP 条目锚点');
  assert.ok(archive.includes('](#v1-7-20-acp)'), '档案索引未指向 ACP 条目');
  assert.ok(archive.includes('maintenance-acp.md'), '档案未交叉引用 ACP 页面');

  // 草稿跟着下一个版本号走：1.7.21 已被上游发行占用，ACP 补录的草稿顺延到 1.7.25。
  const draft = read('docs/releases/1.7.25.md');
  assert.ok(fs.statSync('docs/releases/1.7.25.md').size <= 8 * 1024, '发行摘要超过 8 KiB');
  assert.ok(draft.includes('发版清单'), '草稿缺少发版清单');
  // 草稿只有在版本号真 bump 之后才允许自称正式版；否则必须保留草稿标记。
  const first = draft.split('\n')[0].trim();
  assert.ok(first === `# ${pkg.version}` || first.includes('草稿'), `首行既不是当前版本也不是草稿：${first}`);
});

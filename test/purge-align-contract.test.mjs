// 一键脚本是"能装"和"装上了但没生效"之间的分界线：
// Electron 优先加载 app.asar，而补丁写在 Resources/app，不换加载源就等于白装。
// 这里钉住：入口脚本存在且可执行、参数契约、旧备份修复的判读规则、文档三条路径都指向它。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLegacyFailure } from '../scripts/purge-align.mjs';

const read = (file) => fs.readFileSync(file, 'utf8');

test('quickstart and align scripts exist and are executable', () => {
  for (const file of ['scripts/quickstart.sh', 'scripts/purge-align.mjs']) {
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
    // Windows 检出不留执行位（git 也不跟踪它），这一条只在 POSIX 上成立。
    if (process.platform === 'win32') continue;
    const mode = fs.statSync(file).mode & 0o777;
    assert.ok(mode & 0o100, `${file} 需要可执行位（当前 ${mode.toString(8)}）`);
  }
});

test('align script exposes the documented subcommands', () => {
  const out = execFileSync(process.execPath, ['scripts/purge-align.mjs', '--help'], { encoding: 'utf8' });
  for (const cmd of ['align', 'status', 'revert', 'apply', 'sign']) assert.ok(out.includes(cmd), `帮助里缺少 ${cmd}`);
  for (const flag of ['--app', '--profile', '--no-sign', '--dry-run', '--recover-legacy']) assert.ok(out.includes(flag), `帮助里缺少 ${flag}`);
});

test('quickstart shell script points at the two layers it must handle', () => {
  const sh = read('scripts/quickstart.sh');
  for (const needle of ['purge-align.mjs', 'bootstrap-install.mjs', 'app.asar', 'Resources/app', '--revert', '--dry-run']) {
    assert.ok(sh.includes(needle), `quickstart.sh 缺少：${needle}`);
  }
  // 脚本自己声明不重启、不卸载、不改源：这三条是安装边界，写丢了下一个人会照着重写一套。
  for (const needle of ['不卸载旧包装', '不改 npm 源', '不自动重启宿主']) {
    assert.ok(sh.includes(needle), `quickstart.sh 缺少边界声明：${needle}`);
  }
});

test('help exits 0 for both entry points', () => {
  assert.equal(execFileSync(process.execPath, ['scripts/purge-align.mjs', '--help']).length > 0, true);
  const shell = process.platform === 'win32' ? null : execFileSync('sh', ['scripts/quickstart.sh', '--help'], { encoding: 'utf8' });
  if (shell !== null) assert.ok(shell.includes('quickstart'), 'quickstart --help 内容不对');
});

test('legacy permission failures are classified, not guessed', () => {
  const repairable = parseLegacyFailure('Legacy permission migration: /tmp/a/dsh-sandbox-local/lib/index.js: backup already contains a retired permission marker');
  assert.deepEqual(repairable, {
    file: '/tmp/a/dsh-sandbox-local/lib/index.js',
    reason: 'backup already contains a retired permission marker',
    repairable: true,
  });

  const other = parseLegacyFailure('Legacy permission migration: /tmp/a/x.js: unrelated changes differ from the backup; original files preserved');
  assert.equal(other.repairable, false, '不是"备份被污染"的原因不能被当成可自动修复');

  assert.equal(parseLegacyFailure('something else entirely'), null);
  assert.equal(parseLegacyFailure(undefined), null);
  // 多行只读第一行：引擎把路径与原因放在同一行，后面可能是堆栈。
  assert.equal(parseLegacyFailure('Legacy permission migration: /tmp/b.js: missing backup for possible retired permission edit\nat foo').repairable, false);
});

test('align script still runs when invoked through a symlinked path', () => {
  // /tmp -> /private/tmp 这类符号链接会让 "argv[1] === import.meta.url" 判断失效，
  // 脚本会一声不响地什么都不做还返回 0。这条用例钉住 realpath 比较。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-align-link-'));
  const link = path.join(dir, 'align-link.mjs');
  try {
    fs.symlinkSync(path.resolve('scripts/purge-align.mjs'), link);
    const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.ok(out.includes('--recover-legacy'), '通过符号链接调用时脚本没有执行');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entry docs carry the one-command path', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('scripts/quickstart.sh'), 'README 未提一键脚本');
  assert.ok(readme.includes('curl -fsSL'), 'README 缺少可直接复制的下载命令');
  assert.equal(read('README.zh-CN.md'), readme, 'README.zh-CN.md 必须与 README.md 逐字一致');
  const install = read('docs/INSTALLATION.md');
  assert.ok(install.includes('quickstart.sh'), 'INSTALLATION 未写一键脚本');
  assert.ok(install.includes('app.asar'), 'INSTALLATION 未说明加载源这一步');
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('quickstart.sh'), 'AGENTS.md 未登记一键脚本');
});

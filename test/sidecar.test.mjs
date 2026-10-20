/**
 * 旁挂配置（sidecar）回归：`node test/sidecar.test.mjs`
 *
 * 钉的是 2026-10-20 那次事故：宿主某次保存配置时把 `cordis.yml` 里整个
 * `config:` 段删掉了，`xiaoheiheCookie` 凭空消失，小黑盒数字 id 又开始
 * show_captcha，而插件本身毫无异常 —— 极难看出是配置被吃了。
 *
 * 现在 cookie 的优先级是 sidecar > yml > 内存，这里验证那个顺序真的成立。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSidecar, saveSidecar, sidecarPath } from '../lib/config.js';

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✘ ${name}\n      ${error?.message ?? error}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'link-parse-sidecar-'));
const sandbox = join(tmp, 'cfg.json');
process.env.DSH_LINK_PARSE_CONFIG = sandbox;

console.log('\n[1] 路径');
ok('环境变量能覆盖路径', () => {
  assert.equal(sidecarPath(), sandbox);
});

console.log('\n[2] 读写');
ok('文件不存在 → 空对象，不抛错', () => {
  assert.deepEqual(loadSidecar(), {});
});
ok('saveSidecar 能写、能读回', () => {
  assert.equal(saveSidecar({ xiaoheiheCookie: 'x_xhh_tokenid=AAA' }), true);
  assert.equal(loadSidecar().xiaoheiheCookie, 'x_xhh_tokenid=AAA');
});
ok('写入是合并，不覆盖别的键', () => {
  saveSidecar({ githubToken: 'ghp_x' });
  const got = loadSidecar();
  assert.equal(got.xiaoheiheCookie, 'x_xhh_tokenid=AAA');
  assert.equal(got.githubToken, 'ghp_x');
});

console.log('\n[3] 坏文件不能炸');
ok('JSON 坏了 → 空对象 + warn', () => {
  writeFileSync(sandbox, '{ 这不是 JSON', 'utf8');
  const warns = [];
  assert.deepEqual(loadSidecar((m) => warns.push(m)), {});
  assert.equal(warns.length, 1);
});
ok('顶层是数组 → 忽略', () => {
  writeFileSync(sandbox, '[1,2,3]', 'utf8');
  const warns = [];
  assert.deepEqual(loadSidecar((m) => warns.push(m)), {});
  assert.equal(warns.length, 1);
});

console.log('\n[4] resolveCookie 的优先级（sidecar > yml > 内存）');
ok('sidecar 有时用 sidecar', async () => {
  const { resolveCookie } = await import('../lib/live-cookie.js');
  writeFileSync(sandbox, JSON.stringify({ xiaoheiheCookie: 'FROM_SIDECAR' }), 'utf8');
  assert.equal(resolveCookie({ xiaoheiheCookie: 'FROM_MEMORY' }), 'FROM_SIDECAR');
});
ok('sidecar 为空串时不遮蔽下层', async () => {
  const { resolveCookie } = await import('../lib/live-cookie.js');
  writeFileSync(sandbox, JSON.stringify({ xiaoheiheCookie: '' }), 'utf8');
  const got = resolveCookie({ xiaoheiheCookie: 'FROM_MEMORY' });
  assert.notEqual(got, '', '不该返回空串');
});

rmSync(tmp, { recursive: true, force: true });
delete process.env.DSH_LINK_PARSE_CONFIG;

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);

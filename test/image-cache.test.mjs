/**
 * dsh-link-parse / test/image-cache.test.mjs
 *
 * 验图片缓存的定位与清理：按年龄删、按总量删、目录不存在不炸、删不掉不炸。
 *
 * 用 mkdtemp 建隔离目录，绝不碰真的 mediaDir。
 *
 * 跑：node test/image-cache.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneImageCache, resolveCacheDir, CACHE_SUBDIR } from '../lib/image-cache.js';

let pass = 0;
let fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
};

const root = mkdtempSync(join(tmpdir(), 'linkparse-cache-'));

/** 造一个文件，size 字节，mtime 距今 ageMs 毫秒。 */
function makeFile(dir, name, size, ageMs) {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(size, 0x41));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

const KB = 1024;

function fresh(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

console.log('[1] 缓存目录定位');
{
  eq('默认落在 mediaDir 子目录', resolveCacheDir('D:\\media', ''), join('D:\\media', CACHE_SUBDIR));
  eq('配置绝对路径直接采用', resolveCacheDir('D:\\media', 'E:\\pics'), 'E:\\pics');
  eq('配置相对名挂到 mediaDir 下', resolveCacheDir('D:\\media', 'tmp-pics'), join('D:\\media', 'tmp-pics'));
  eq('空白配置当未配置', resolveCacheDir('D:\\media', '   '), join('D:\\media', CACHE_SUBDIR));
}

console.log('[2] 目录不存在：静默返回，不抛');
{
  const r = await pruneImageCache({ dir: join(root, 'does-not-exist'), maxAgeMs: 1000, maxBytes: 1000 });
  eq('scanned=0', r.scanned, 0);
  eq('没有 error 字段', 'error' in r, false);
}

console.log('[3] 按保留期删：超龄的走，新的留');
{
  const dir = fresh('age');
  const old1 = makeFile(dir, 'old1.jpg', 10 * KB, 5 * 24 * 3600 * 1000); // 5 天前
  const old2 = makeFile(dir, 'old2.jpg', 10 * KB, 4 * 24 * 3600 * 1000); // 4 天前
  const keep = makeFile(dir, 'keep.jpg', 10 * KB, 1 * 3600 * 1000);      // 1 小时前
  const r = await pruneImageCache({ dir, maxAgeMs: 3 * 24 * 3600 * 1000, maxBytes: 0 });
  eq('过期删了 2 张', r.removedByAge, 2);
  eq('没按体积删', r.removedBySize, 0);
  eq('old1 已消失', existsSync(old1), false);
  eq('old2 已消失', existsSync(old2), false);
  eq('keep 还在', existsSync(keep), true);
  eq('保留字节数正确', r.keptBytes, 10 * KB);
}

console.log('[4] 按总量删：最旧的先走，降回线内就停');
{
  const dir = fresh('size');
  // 6 个 10KB = 60KB，上限 25KB → 必须删到剩 ≤25KB，即删 4 个（剩 2 个 20KB）。
  const files = [];
  for (let i = 0; i < 6; i += 1) {
    files.push(makeFile(dir, `f${i}.jpg`, 10 * KB, (6 - i) * 3600 * 1000)); // f0 最旧
  }
  const r = await pruneImageCache({ dir, maxAgeMs: 0, maxBytes: 25 * KB });
  eq('按体积删了 4 张', r.removedBySize, 4);
  eq('没按年龄删', r.removedByAge, 0);
  eq('最旧的 f0 没了', existsSync(files[0]), false);
  eq('最新的 f5 还在', existsSync(files[5]), true);
  eq('剩余字节 ≤ 上限', r.keptBytes <= 25 * KB, true);
  eq('剩余 2 张', readdirSync(dir).length, 2);
}

console.log('[5] 两项都配上：先按年龄，够用就不再按体积删');
{
  const dir = fresh('both');
  makeFile(dir, 'a.jpg', 100 * KB, 10 * 24 * 3600 * 1000); // 又老又大
  makeFile(dir, 'b.jpg', 10 * KB, 1 * 3600 * 1000);        // 新的小的
  const r = await pruneImageCache({ dir, maxAgeMs: 3 * 24 * 3600 * 1000, maxBytes: 50 * KB });
  eq('先删过期的 1 张', r.removedByAge, 1);
  eq('剩下的没超线，不再按体积删', r.removedBySize, 0);
  eq('剩 1 张', readdirSync(dir).length, 1);
}

console.log('[6] 全是新的、也没超线：一张都不动');
{
  const dir = fresh('none');
  makeFile(dir, 'a.jpg', 1 * KB, 1000);
  makeFile(dir, 'b.jpg', 1 * KB, 1000);
  const r = await pruneImageCache({ dir, maxAgeMs: 3 * 24 * 3600 * 1000, maxBytes: 150 * 1024 * KB });
  eq('没删任何东西', r.removedByAge + r.removedBySize, 0);
  eq('仍然 2 张', readdirSync(dir).length, 2);
}

console.log('[7] 上限为 0 表示不限：不删');
{
  const dir = fresh('unlimited');
  makeFile(dir, 'a.jpg', 100 * KB, 99 * 24 * 3600 * 1000);
  const r = await pruneImageCache({ dir, maxAgeMs: 0, maxBytes: 0 });
  eq('过期删 0', r.removedByAge, 0);
  eq('体积删 0', r.removedBySize, 0);
  eq('文件还在', readdirSync(dir).length, 1);
}

console.log('[8] 子目录不被当成文件处理');
{
  const dir = fresh('withdir');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  makeFile(dir, 'a.jpg', 1 * KB, 99 * 24 * 3600 * 1000);
  const r = await pruneImageCache({ dir, maxAgeMs: 3600 * 1000, maxBytes: 0 });
  eq('只统计到 1 个文件', r.scanned, 1);
  eq('过期删了那个文件', r.removedByAge, 1);
  eq('子目录还在', existsSync(join(dir, 'sub')), true);
}

rmSync(root, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 验证：cordis.yml 整份仍是合法 YAML，且 dsh-link-parse 插在合理位置。
//
// 从 DSH_HOME / USERPROFILE 推断 profile 路径，可用 DSH_PROFILE_DIR 覆盖：
//   DSH_PROFILE_DIR=<profile 目录>  node test/yaml-check.mjs
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop');
const anchor = join(profileDir, 'package.json');
const cordisPath = join(profileDir, 'cordis.yml');

if (!existsSync(anchor) || !existsSync(cordisPath)) {
  console.log('跳过：找不到 profile（' + profileDir + '）');
  console.log('提示：设 DSH_PROFILE_DIR 指向你的 profile 目录再跑一次。');
  process.exit(0);
}

const require = createRequire(anchor);
const YAML = require('yaml');

// cordis.yml 用了 !!js（标量 / 映射两种写法）和 !ctx.get(...) 自定义标签。
// 这里只为了验证「整份文件仍是合法 YAML」+「link-parse 插在了对的位置」，
// 所以给这些标签登记最宽松的 resolve。
const doc = YAML.parse(readFileSync(cordisPath, 'utf8'), {
  customTags: [
    { tag: '!!js', resolve: (v) => ({ __js: v }) },
    { tag: '!ctx.get', resolve: (v) => ({ __ctxGet: v }) },
  ],
  // 允许未知标签一律当标量，避免漏掉某个标签就整份解析失败
  logLevel: 'silent',
});

const arr = Array.isArray(doc) ? doc : null;
if (arr === null) {
  console.log('顶层不是数组：', typeof doc);
  process.exit(0);
}
console.log('entries:', arr.length);
const idx = arr.findIndex((e) => e && e.name === 'dsh-link-parse');
console.log('link-parse index:', idx);
console.log('entry:', JSON.stringify(arr[idx]));
console.log('prev :', JSON.stringify(arr[idx - 1]));
console.log('next :', JSON.stringify(arr[idx + 1]));
const ids = arr.map((e) => e?.id).filter(Boolean);
console.log('dup ids:', ids.filter((v, i, a) => a.indexOf(v) !== i));

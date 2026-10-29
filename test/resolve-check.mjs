// 验证：包能被 profile 解析到吗、入口能 import 吗、依赖从哪来。
//
// 2026-10-29：原来这里写死了本机绝对路径
// （`createRequire('<某个人的家目录>/.dsh/profiles/desktop/package.json')`），
// 一旦公开就泄露了用户名，而且换台机器根本跑不了。
//
// 现在从 DSH_HOME / USERPROFILE 推断，可用环境变量覆盖：
//   DSH_PROFILE_DIR=<profile 目录>  node test/resolve-check.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop');
const anchor = join(profileDir, 'package.json');

if (!existsSync(anchor)) {
  console.log(`跳过：找不到 profile（${anchor}）`);
  console.log('提示：设 DSH_PROFILE_DIR 指向你的 profile 目录再跑一次。');
  process.exit(0);
}

const require = createRequire(anchor);

// 1) 包能被 profile 解析到吗（等于宿主 `import 'dsh-link-parse'` 的路径）
const pkgPath = require.resolve('dsh-link-parse/package.json');
console.log('resolve ok:', pkgPath);
const pkg = require('dsh-link-parse/package.json');
console.log('main:', pkg.main, '| type:', pkg.type);

// 2) 入口能被真正 import 吗
const entry = pathToFileURL(require.resolve('dsh-link-parse')).href;
const mod = await import(entry);
console.log('exports:', Object.keys(mod).join(','));
console.log('name:', mod.name, '| inject:', JSON.stringify(mod.inject));

// 3) 依赖都能从 profile 解析（绝不能依赖插件自己目录里的 node_modules）
for (const dep of ['dsh-ops', 'dsh-proxy-on-demand']) {
  try { console.log('dep ok:', dep, '->', require.resolve(dep)); }
  catch (e) { console.log('dep MISSING:', dep, e.code); }
}

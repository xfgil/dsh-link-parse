import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('C:\\Users\\xsbei\\.dsh\\profiles\\desktop\\package.json');

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

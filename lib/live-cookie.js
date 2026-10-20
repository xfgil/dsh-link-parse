/**
 * dsh-link-parse / lib/live-cookie.js
 *
 * 从 profile 的 `cordis.yml` 里**现读** cookie，而不是只信 apply() 时拿到的那份配置。
 *
 * ## 为什么需要这个
 *
 * 2026-10-19 实测：改完 `cordis.yml` 里的 `xiaoheiheCookie` 之后，用
 * `POST /dsh-hot-reloader/reload` 重载本插件，工具行为**没有任何变化**——热重载只是
 * 重新 import 模块、用 loader 内存里那份**旧的** config 再跑一遍 apply()，它不会去
 * 重新解析 yml。
 *
 * cookie 这个字段又恰好是「会过期、需要勤换」的东西（小黑盒的 x_xhh_tokenid 几周就
 * 换一次）。如果每次换 cookie 都得重启整个宿主，那这个字段就没法用了。
 *
 * 所以这里做一件很小的事：需要 cookie 的那一刻，去 profile 目录把 `cordis.yml` 读一眼，
 * 按 mtime 缓存，把里面写的值当成准的。配置改了立刻生效，不用重启。
 *
 * ## 边界
 *
 * - 只认一行 `xiaoheiheCookie:`，不做完整 YAML 解析（宿主那份 yml 里有 `!!js` 自定义
 *   标签，正经解析器反而会炸）。
 * - 找不到 profile 就返回空字符串，调用方回退到内存里的配置值，行为不变。
 * - 文件读失败一律吞掉：cookie 拿不到最多是「数字 id 走验证码」，不该让工具报错。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSidecar } from './config.js';

/** 缓存：filePath -> { mtimeMs, value } */
const cache = new Map();

/** profile 根目录候选（按可能性排序，第一个存在且有 cordis.yml 的胜出）。 */
function profileCandidates() {
  const homes = [process.env.DSH_HOME, process.env.USERPROFILE, process.env.HOME, os.homedir()]
    .filter((value) => typeof value === 'string' && value.length > 0);
  const roots = [];
  for (const home of homes) {
    const profiles = path.join(home, '.dsh', 'profiles');
    if (!fs.existsSync(profiles)) continue;
    // 先看有没有明确指定的 profile，再退化成「把所有 profile 都试一遍」。
    const named = process.env.DSH_PROFILE;
    if (named) roots.push(path.join(profiles, named, 'cordis.yml'));
    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(path.join(profiles, entry.name, 'cordis.yml'));
      }
    } catch {
      /* 没权限就算了 */
    }
  }
  return roots;
}

/**
 * 从一段 yml 文本里抠出 `xiaoheiheCookie` 的值。
 *
 * 只处理这个字段会出现的几种朴素写法：
 *   - xiaoheiheCookie: 'abc'
 *   - xiaoheiheCookie: "abc"
 *   - xiaoheiheCookie: abc
 *   - xiaoheiheCookie: ''      → 空字符串
 * YAML 单引号内的 `''` 表示一个单引号，这里一并还原。
 */
export function extractCookieFromYaml(text) {
  const match = /^[ \t]*-?[ \t]*xiaoheiheCookie:[ \t]*(.*)$/m.exec(text);
  if (!match) return '';
  let value = match[1].trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  // 裸值后面可能跟注释
  const hash = value.indexOf(' #');
  if (hash >= 0) value = value.slice(0, hash).trim();
  return value;
}

/**
 * 读一次 profile 里的 `xiaoheiheCookie`。
 *
 * @returns {string} 找到就返回非空字符串；找不到/没配/读失败返回 ''。
 */
export function readLiveCookie() {
  for (const file of profileCandidates()) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) {
      if (hit.value) return hit.value;
      continue;
    }
    let value = '';
    try {
      value = extractCookieFromYaml(fs.readFileSync(file, 'utf8'));
    } catch {
      value = '';
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, value });
    if (value) return value;
  }
  return '';
}

/**
 * 拿到实际要用的 cookie。
 *
 * 优先级（2026-10-20 加了旁挂文件这一层）：
 *
 *   1. **旁挂配置** `~/.dsh/link-parse.json`（见 `config.js` 的 `sidecarPath`）。
 *      放在最前面，因为它是唯一不会被宿主改写的地方 —— 实测宿主某次保存
 *      配置时把 `cordis.yml` 里整个 `config:` 段删掉了，cookie 凭空消失，
 *      而插件本身毫无异常。
 *   2. `cordis.yml` 现读（热改不用重启，见文件头）。
 *   3. apply() 时内存里那份（启动时解析出来的，最陈旧）。
 *
 * @param {object} cfg apply() 时合并出来的配置
 * @returns {string}
 */
export function resolveCookie(cfg) {
  const sidecar = loadSidecar();
  if (typeof sidecar.xiaoheiheCookie === 'string' && sidecar.xiaoheiheCookie !== '') {
    return sidecar.xiaoheiheCookie;
  }
  return readLiveCookie() || cfg?.xiaoheiheCookie || '';
}

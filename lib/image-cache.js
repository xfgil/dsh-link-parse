/**
 * dsh-link-parse / lib/image-cache.js
 *
 * 自动下载的帖子配图放哪儿、什么时候删掉。
 *
 * ## 为什么要有这个模块（2026-10-20，用户原话「读完后会删吗？不然我硬盘遭不住啊」）
 *
 * `link_parse` 现在会把图文帖的前几张图下到本地，好让模型能 `read_image` 真看到。
 * 但下载是一次性的、读取却随时可能发生在之后 —— 插件根本不知道模型什么时候读完
 * （`read_image` 是宿主工具，不回话给插件）。所以不能「读完立刻删」，
 * 只能**按时间 + 总量**做兜底回收。
 *
 * ## 为什么放在 mediaDir 之下（不是挪去别的盘）
 *
 * 两道围栏都只认 mediaDir 前缀，且都是「realpath 后做 目录+分隔符 前缀比较」：
 *   - `dsh-onebot-qq/lib/media.js:resolveContainedPath()`
 *   - `dsh-onebot-companion/lib/modules/isolation.js:isUnderDir()`
 * 子目录天然通过，外面一律不行。真要换盘得连 onebot-qq 的 mediaDir 一起改，
 * 会把语音/表情/所有聊天图片一起搬走 —— 为几张配图不值当。
 *
 * ## 为什么不用 setInterval 做定时清理
 *
 * 插件热重载会重建整棵实例。定时器会跟着旧实例丢；更糟的是重载后可能留下两份，
 * 同时删文件。挂在工具调用前顺手做一次，既没有生命周期问题，频率也天然合理
 * （没在解析链接，就没有新图进来）。
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 缓存目录相对 mediaDir 的默认子目录名。 */
export const CACHE_SUBDIR = '.link-parse-cache';

/**
 * 算出缓存目录的绝对路径。
 *
 * @param {string} mediaDir onebot-qq 的媒体目录（围栏根，必须是它的子目录）
 * @param {string} [configured] 配置里覆盖的子目录（绝对路径或相对 mediaDir）
 * @returns {string}
 */
export function resolveCacheDir(mediaDir, configured = '') {
  const raw = typeof configured === 'string' ? configured.trim() : '';
  if (raw !== '') {
    // 绝对路径（含盘符）直接用；相对路径挂到 mediaDir 下。
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) return raw;
    return join(mediaDir, raw);
  }
  return join(mediaDir, CACHE_SUBDIR);
}

/**
 * 清理缓存目录：先按「保留期」，再按「总量上限」。
 *
 * 顺序不能反：先删过期的，可能总量就已经降下来了，不必再按体积删。
 * 都按 mtime 升序（最旧先走），因为 mtime 就是「这张图何时进来的」。
 *
 * **整个函数不抛错**：清理失败绝不能打断解析。返回统计给日志用。
 *
 * @param {object} options
 * @param {string} options.dir 缓存目录
 * @param {number} [options.maxAgeMs] 超过这个年龄的删掉
 * @param {number} [options.maxBytes] 总量上限
 * @returns {Promise<{scanned: number, removedByAge: number, removedBySize: number, freedBytes: number, keptBytes: number}>}
 */
export async function pruneImageCache(options = {}) {
  const { dir, maxAgeMs = 0, maxBytes = 0 } = options;
  const stats = { scanned: 0, removedByAge: 0, removedBySize: 0, freedBytes: 0, keptBytes: 0 };
  if (!dir) return stats;

  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    // 目录还不存在是最常见的情况（第一次解析之前），静默返回。
    if (error?.code !== 'ENOENT') stats.error = error?.message ?? String(error);
    return stats;
  }

  /** @type {{path: string, size: number, mtimeMs: number}[]} */
  const files = [];
  const now = Date.now();
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      stats.scanned += 1;

      if (maxAgeMs > 0 && now - info.mtimeMs > maxAgeMs) {
        try {
          await rm(path, { force: true });
          stats.removedByAge += 1;
          stats.freedBytes += info.size;
          continue; // 已经删了，不再参与体积统计
        } catch {
          /* 删不掉（被占用）就留着，下次再试 */
        }
      }
      files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* stat 失败的文件跳过 */
    }
  }

  let kept = files.reduce((sum, f) => sum + f.size, 0);
  if (maxBytes > 0 && kept > maxBytes) {
    // 最旧的先删，直到降回线内。
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (kept <= maxBytes) break;
      try {
        await rm(f.path, { force: true });
        stats.removedBySize += 1;
        stats.freedBytes += f.size;
        kept -= f.size;
      } catch {
        /* 删不掉就跳过，别卡在这一张上 */
      }
    }
  }

  stats.keptBytes = kept;
  return stats;
}

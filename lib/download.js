/**
 * dsh-link-parse / lib/download.js
 *
 * 把视频/图片下到本地 QQ 媒体目录，好让 `qq_send_video` / `qq_send_image`
 * 能发出去。
 *
 * ## 为什么必须落在这个目录
 *
 * `dsh-onebot-qq` 的出站围栏（`bridge.mediaSendRoots`）只允许从
 * **mediaDir**（以及管理员回合的会话工作区）里读文件，别处一律
 * `path not allowed`。所以下载落点必须和它的 `mediaDir` 配置一致。
 * 没配 `mediaDir` 时退回当前工作目录（见 lib/config.js）。
 *
 * ## 为什么不用 fetch().arrayBuffer()
 *
 * B 站/抖音的视频会有几百 MB，一次性 buffer 进内存没必要，而且没法边下边
 * 检查体积。这里用 `Readable.fromWeb` 手动 pipe 到文件，同时累计字节数，
 * 超限就中止并删掉半成品。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DESKTOP_UA } from './config.js';

/** 从 URL 猜扩展名，猜不到按调用方给的默认值。 */
function guessExt(url, fallback) {
  try {
    const path = new URL(url).pathname;
    const ext = extname(path).toLowerCase();
    if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * 嗅探文件头，纠正被图床标错的扩展名。
 *
 * ## 为什么需要（2026-10-20 实测踩到）
 *
 * 小黑盒的图床把 JPEG 挂在 `.png` 路径上返回。落地文件叫 `xxx.png`，但字节是
 * `ff d8 ff e0 4a 46 49 46`（JPEG）。`read_image` 会按扩展名判断 MIME，直接报
 * "the .png extension declares image/png, but the bytes use a different image format"
 * —— 图下下来了却读不了，等于白下。
 *
 * 只在**能明确认出来**时改名：认不出就维持原样，不猜。
 *
 * @returns {string|null} 纠正后的扩展名（含点），认不出返回 null
 */
function sniffImageExt(head) {
  if (!head || head.length < 12) return null;
  const b = head;
  // JPEG: ff d8 ff
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  // PNG: 89 50 4e 47 0d 0a 1a 0a
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  // GIF: 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return '.gif';
  // WEBP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp';
  return null;
}

/** 只对图片扩展名做嗅探纠正；视频文件头太多样，不动。 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * 下载一个远程文件到 `mediaDir`。
 *
 * @param {string} url
 * @param {object} options
 * @param {string} options.mediaDir 落地目录（会 mkdir -p）
 * @param {number} [options.maxBytes] 体积上限
 * @param {string} [options.referer] 防盗链所需的 Referer
 * @param {string} [options.defaultExt] URL 里没有扩展名时的兜底
 * @param {string} [options.nameHint] 文件名提示（会清洗成安全字符）
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function downloadToMedia(url, options = {}) {
  const {
    mediaDir,
    maxBytes = 80 * 1024 * 1024,
    referer = '',
    defaultExt = '.mp4',
    nameHint = 'linkparse',
    proxyUrl = '',
    timeoutMs = 60000,
  } = options;

  if (!mediaDir) throw new Error('mediaDir 未配置，无法下载到本地');
  await mkdir(mediaDir, { recursive: true });

  const ext = guessExt(url, defaultExt);
  // 文件名提示要**保留中文**：原来的 `[^\w.-]` 会把整个中文标题压成一个下划线，
  // 落地文件全叫 `_-20261019...jpeg`，事后根本认不出是哪条帖子。
  // 只清掉 Windows 不允许的字符与空白，再截断。
  const safeHint = String(nameHint)
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 40) || 'linkparse';
  const fileName = `${safeHint}-${stamp()}-${randomBytes(3).toString('hex')}${ext}`;
  const filePath = join(mediaDir, fileName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let written = 0;

  try {
    // 代理开启时不下（unidici 的自定义 agent 依赖 externals），直接报清楚，
    // 不要假装成功。
    if (proxyUrl) {
      throw new Error(
        '下载暂不支持走代理（要出墙的站请先直连下载或用 videoUrl 自己抓）；'
        + '如需代理下载，请把 mediaDir 指到能直连的环境。',
      );
    }

    const headers = { 'User-Agent': DESKTOP_UA };
    if (referer) headers.Referer = referer;
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`下载失败 HTTP ${response.status}：${url.slice(0, 120)}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared && declared > maxBytes) {
      throw new Error(`文件 ${declared} 字节超过上限 ${maxBytes} 字节`);
    }
    if (!response.body) throw new Error('响应没有 body');

    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => {
      written += chunk.length;
      if (written > maxBytes) {
        source.destroy(new Error(`下载超过上限 ${maxBytes} 字节，已中止`));
      }
    });
    await pipeline(source, createWriteStream(filePath));

    // 图床经常把 JPEG 挂在 .png 路径上（小黑盒实测有）。落盘名字错了，
    // read_image 会按扩展名判 MIME 然后拒绝读 —— 图下下来了却看不见。
    // 所以下完嗅一嗅文件头，认得出就改名。
    let finalPath = filePath;
    if (IMAGE_EXTS.has(ext)) {
      finalPath = await fixImageExtension(filePath, ext);
    }

    const info = await stat(finalPath);
    return { path: finalPath, bytes: info.size };
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 嗅文件头，扩展名不对就改名。
 *
 * 读不出头（文件太小、IO 失败）就原样返回 —— 改名失败绝不能让下载失败。
 *
 * @param {string} filePath 已落盘的文件
 * @param {string} ext 当前扩展名（含点，小写）
 * @returns {Promise<string>} 最终路径（可能同名）
 */
async function fixImageExtension(filePath, ext) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (bytesRead < 12) return filePath;
    const real = sniffImageExt(head);
    if (!real) return filePath;
    // .jpeg 和 .jpg 是同一个东西，别为了这个多改一次名字。
    const normalize = (e) => (e === '.jpeg' ? '.jpg' : e);
    if (normalize(real) === normalize(ext)) return filePath;
    const next = filePath.slice(0, filePath.length - ext.length) + real;
    await rename(filePath, next);
    return next;
  } catch {
    return filePath;
  } finally {
    await handle?.close().catch(() => {});
  }
}

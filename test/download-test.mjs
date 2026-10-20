import { parseLink } from '../lib/parse.js';
import { downloadToMedia } from '../lib/download.js';

const cfg = { mediaDir: process.env.TEMP + '\\linkparse-test', maxDownloadBytes: 60 * 1024 * 1024 };
const parsed = await parseLink('https://www.bilibili.com/video/BV1GJ411x7h7', {});
console.log('videoUrl', parsed.videoUrl.slice(0, 80));
console.log('backend', parsed.videoBackend, 'quality', parsed.quality);
try {
  const f = await downloadToMedia(parsed.videoUrl, { ...cfg, referer: parsed.url, defaultExt: '.mp4', nameHint: 'test', timeoutMs: 60000 });
  console.log('downloaded', f.path, f.bytes);
} catch (e) {
  console.log('download FAIL', e.message);
}

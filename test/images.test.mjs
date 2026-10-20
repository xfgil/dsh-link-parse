/**
 * 验证：link_parse 会把图下到 mediaDir，并给出 localImages 路径。
 *
 * 用法：node test/images.test.mjs <url> [<url> ...]
 * 不带参数时用一条小黑盒 hex 短链跑冒烟。
 */
import { parseLink } from '../lib/parse.js';
import { resolveCookie } from '../lib/live-cookie.js';
import { downloadToMedia } from '../lib/download.js';
import { DEFAULTS } from '../lib/config.js';

const cfg = {
  ...DEFAULTS,
  autoDownloadImages: 3,
  xiaoheiheCookie: resolveCookie({}),
};

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push('https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=ws2LZrdLUIF9Fs1x&h_src=YXBwX3NoYXJl&link_id=60ab72a8f395&new_post_share_style_v2=0');
}

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}${extra ? ` ${extra}` : ''}`);
  else { failures += 1; console.log(`  ✘ ${name}${extra ? ` ${extra}` : ''}`); }
};

for (const url of urls) {
  console.log(`\n== ${url.slice(0, 80)}…`);
  const r = await parseLink(url, cfg);
  console.log(`   ${r.platform}/${r.kind} | ${r.title ?? '（无标题）'} | images=${(r.images ?? []).length}`);

  const picked = (r.images ?? []).slice(0, cfg.autoDownloadImages);
  const paths = [];
  for (const img of picked) {
    try {
      const f = await downloadToMedia(img, {
        mediaDir: cfg.mediaDir,
        maxBytes: cfg.maxImageBytes,
        referer: r.url || url,
        defaultExt: '.jpg',
        nameHint: r.title || r.platform,
      });
      paths.push(f.path);
      console.log(`   ↓ ${f.path}（${f.bytes} 字节）`);
    } catch (error) {
      console.log(`   ! 这张下载失败（不影响其它）：${error.message}`);
    }
  }
  check('至少下到一张图', paths.length > 0, `${paths.length}/${picked.length}`);
  check('落点都在 mediaDir 内', paths.every((p) => p.startsWith(cfg.mediaDir)));
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);

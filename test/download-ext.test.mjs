/**
 * dsh-link-parse / test/download-ext.test.mjs
 *
 * 验「图床把 JPEG 挂在 .png 路径上」这种情况会不会被自动纠正。
 *
 * 复现依据（2026-10-20 实测）：小黑盒图床返回 `.../thumb.png?...`，但字节是
 * `ff d8 ff e0 4a 46 49 46`（JPEG JFIF）。落成 `.png` 后 `read_image` 直接报
 * "the .png extension declares image/png, but the bytes use a different image format"。
 *
 * 跑：node test/download-ext.test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';
import { downloadToMedia } from '../lib/download.js';

let pass = 0;
let fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
};

/** 最小的 JPEG 头（ff d8 ff e0 + JFIF）。后面补点字节，凑够 12+。 */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(200, 0x41),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 0x42),
]);
const GIF_BYTES = Buffer.concat([
  Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  Buffer.alloc(200, 0x43),
]);

const media = mkdtempSync(join(tmpdir(), 'linkparse-ext-'));

// 本地起一个服务，按路径返回不同的「错标」内容。
const server = createServer((req, res) => {
  if (req.url.startsWith('/fake.png')) {         // 声称 png，实为 jpeg
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(JPEG_BYTES);
  } else if (req.url.startsWith('/real.png')) {  // 真是 png
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_BYTES);
  } else if (req.url.startsWith('/fake.jpg')) {  // 声称 jpg，实为 png
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(PNG_BYTES);
  } else if (req.url.startsWith('/fake.gif')) {  // 声称 gif，实为 jpeg
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(JPEG_BYTES);
  } else if (req.url.startsWith('/short.png')) { // 太短，认不出
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50]));
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('[1] 声称 .png 实为 JPEG：应改名成 .jpg');
{
  const r = await downloadToMedia(`${base}/fake.png`, { mediaDir: media, nameHint: 'fake' });
  eq('扩展名改成 .jpg', extname(r.path), '.jpg');
  eq('文件确实存在且是 JPEG', readFileSync(r.path).subarray(0, 3).toString('hex'), 'ffd8ff');
}

console.log('[2] 真是 PNG：不该动');
{
  const r = await downloadToMedia(`${base}/real.png`, { mediaDir: media, nameHint: 'real' });
  eq('扩展名保持 .png', extname(r.path), '.png');
}

console.log('[3] 声称 .jpg 实为 PNG：改成 .png');
{
  const r = await downloadToMedia(`${base}/fake.jpg`, { mediaDir: media, nameHint: 'misl' });
  eq('扩展名改成 .png', extname(r.path), '.png');
}

console.log('[4] 声称 .gif 实为 JPEG：改成 .jpg');
{
  const r = await downloadToMedia(`${base}/fake.gif`, { mediaDir: media, nameHint: 'gif' });
  eq('扩展名改成 .jpg', extname(r.path), '.jpg');
}

console.log('[5] 文件太短认不出：维持原名，不报错');
{
  const r = await downloadToMedia(`${base}/short.png`, { mediaDir: media, nameHint: 'short' });
  eq('扩展名保持 .png', extname(r.path), '.png');
}

server.close();
rmSync(media, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

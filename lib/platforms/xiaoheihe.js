/**
 * dsh-link-parse / lib/platforms/xiaoheihe.js
 *
 * 小黑盒（xiaoheihe.cn）。2026-10-19 实测结论，全部来自真机验证：
 *
 * ## 它的帖子有两种 id，脾气完全不同
 *
 * | 形态                                   | 例                                     | 无 cookie |
 * | -------------------------------------- | -------------------------------------- | --------- |
 * | 分享短链 `...web/share?link_id=<hex>`  | `link_id=c8b372a70b70`                 | ✅ 直接出正文 |
 * | 网页 `.../app/bbs/link/<数字id>`       | `.../link/194077058`                   | ❌ `show_captcha` |
 * | 网页 `.../app/bbs/link/<hex>`          | `.../link/c8b372a70b70`                | ✅ 直接出正文 |
 *
 * 数字 id 和 hex id **不是同一个数的进制转换**（试过 dec2hex / md5 / sha1，
 * 都不是），是两套并列的标识，服务端各自认。数字 id 那条路必须有
 * `x_xhh_tokenid` 这个 cookie（浏览器首次访问会被种上，或登录后带上），
 * 否则一律 `{"status":"show_captcha"}`。
 *
 * 所以：默认放行，失败时把「为什么失败、怎么补」写进 note，交给上层讲给用户。
 *
 * ## 签名（hkey）
 *
 * `/bbs/app/link/tree` 要 `hkey / _time / nonce` 三个参数，算法已逆出来
 * （见 `signPath`）：三段输入各自按定长字母表做 charCode 取模映射 → 轮转交织
 * → 取前 20 → MD5 → 头 5 位再映射一次、尾 6 位做 AES InvMixColumns 后求和 %100。
 * 纯 `node:crypto` 的 md5，不需要额外依赖。
 *
 * ## 正文格式
 *
 * `link.text` 是一个 **JSON 数组**，元素形如：
 *   `{type:'text', text:'<p>...</p>'}` / `{type:'text', text:'纯文字'}` /
 *   `{type:'img', url:'...', height, width}`。
 * 图集类帖（`use_concept_type=1`）第 0 个元素是一句话简介，后面全是图。
 */

import crypto from 'node:crypto';
import { fetchJson, stripTags } from '../http.js';

const API = 'https://api.xiaoheihe.cn';
const TREE = '/bbs/app/link/tree';

/** 固定参数：客户端自报身份，缺了会被当成老版本踢掉。 */
const CLIENT = {
  app: 'heybox',
  os_type: 'web',
  x_app: 'heybox_website',
  x_client_type: 'web',
  x_os_type: 'Windows',
  x_client_version: '',
  client_type: 'web',
  web_version: '3.0',
  version: '999.0.4',
};

const CHAR_TABLE = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

// ---- GF(2^8) 上的乘法（AES 的 x 是 0x1B 约减多项式）----
const xtime = (v) => ((v & 128) ? ((v << 1) ^ 27) : (v << 1)) & 0xff;
const mul3 = (v) => xtime(v) ^ v;
const mul6 = (v) => mul3(xtime(v));
const mul12 = (v) => mul6(mul3(xtime(v)));
const mul14 = (v) => mul12(v) ^ mul6(v) ^ mul3(v);

function mixColumns(column) {
  const v = [...column];
  while (v.length < 4) v.push(0);
  const mixed = [
    mul14(v[0]) ^ mul12(v[1]) ^ mul6(v[2]) ^ mul3(v[3]),
    mul3(v[0]) ^ mul14(v[1]) ^ mul12(v[2]) ^ mul6(v[3]),
    mul6(v[0]) ^ mul3(v[1]) ^ mul14(v[2]) ^ mul12(v[3]),
    mul12(v[0]) ^ mul6(v[1]) ^ mul3(v[2]) ^ mul14(v[3]),
  ].map((n) => n & 0xff);
  if (v.length > 4) mixed.push(...v.slice(4));
  return mixed;
}

const mapCut = (text, cut) => {
  const table = CHAR_TABLE.slice(0, cut);
  return [...text].map((c) => table[c.charCodeAt(0) % table.length]).join('');
};
const mapFull = (text) => [...text].map((c) => CHAR_TABLE[c.charCodeAt(0) % CHAR_TABLE.length]).join('');

function interleave(parts) {
  const out = [];
  const max = Math.max(...parts.map((p) => p.length));
  for (let i = 0; i < max; i += 1) for (const p of parts) if (i < p.length) out.push(p[i]);
  return out.join('');
}

/** 生成 `/bbs/app/link/tree` 需要的签名参数。 */
export function signPath(path) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.createHash('md5').update(String(now) + String(Math.random())).digest('hex').toUpperCase();
  const normalized = '/' + path.split('/').filter(Boolean).join('/') + '/';
  // 时间戳偏移 +1 是小黑盒自己的口径（lv.g），少这个会签名不匹配
  const merged = interleave([
    mapCut(String(now + 1), -2),
    mapFull(normalized),
    mapFull(nonce),
  ]).slice(0, 20);
  const digest = crypto.createHash('md5').update(merged).digest('hex');
  const prefix = mapCut(digest.slice(0, 5), -4);
  const sum = mixColumns([...digest.slice(-6)].map((c) => c.charCodeAt(0))).reduce((a, b) => a + b, 0) % 100;
  return { hkey: prefix + String(sum).padStart(2, '0'), _time: now, nonce };
}

/** 认链接：返回 { linkId, numeric } 或 null。 */
export function matchXiaoheihe(text) {
  if (!text || !/xiaoheihe\.cn/i.test(text)) return null;
  // 分享短链：?link_id=xxxx
  const fromQuery = text.match(/[?&]link_id=([0-9a-zA-Z]+)/);
  if (fromQuery) return { linkId: fromQuery[1], numeric: /^\d+$/.test(fromQuery[1]) };
  // 网页：/app/bbs/link/<id>
  const fromPath = text.match(/xiaoheihe\.cn\/(?:app\/)?bbs\/link\/([0-9a-zA-Z]+)/);
  if (fromPath) return { linkId: fromPath[1], numeric: /^\d+$/.test(fromPath[1]) };
  return null;
}

/** 帖子的 text 数组 → 纯文本 + 图片列表。 */
function parseBody(rawText, maxTextChars) {
  let blocks;
  try {
    blocks = JSON.parse(rawText);
  } catch {
    return { description: stripTags(String(rawText ?? '')).slice(0, maxTextChars), images: [] };
  }
  if (!Array.isArray(blocks)) return { description: String(rawText ?? '').slice(0, maxTextChars), images: [] };

  const texts = [];
  const images = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'img' || block.url) {
      // thumb.jpeg → .jpeg 拿原图（小黑盒自己的缩略图规则）
      const url = String(block.url ?? block.src ?? '').replace(/\/thumb\.(\w+)$/, '.$1');
      if (url) images.push(url);
      continue;
    }
    const piece = String(block.text ?? '').trim();
    if (piece) texts.push(stripTags(piece));
  }
  const joined = texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { description: joined.slice(0, maxTextChars), images };
}

/**
 * 相邻两次请求的最小间隔（毫秒）。
 *
 * 实测：手速连发（间隔 < 1 秒）时小黑盒会直接甩 show_captcha，跟 cookie 无关；
 * 间隔拉到 6~8 秒后连测 9 次全过。所以这里做进程级串行节流，宁可慢一点。
 */
const MIN_GAP_MS = 6000;

let lastRequestAt = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 排队等一个「上一发之后至少 MIN_GAP_MS」的时刻。 */
function throttle() {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

/** 发一次 link/tree，返回解析后的 JSON（不判状态）。 */
async function requestTree(matched, { timeoutMs, xiaoheiheCookie, referer }) {
  const params = new URLSearchParams({
    ...CLIENT,
    ...signPath(TREE),
    link_id: matched.linkId,
    is_first: '1',
    page: '1',
    index: '1',
    limit: '20',
    owner_only: '0',
  });

  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: referer,
    Origin: 'https://www.xiaoheihe.cn',
  };
  if (xiaoheiheCookie) headers.Cookie = xiaoheiheCookie;

  await throttle();
  return fetchJson(`${API}${TREE}?${params}`, { timeoutMs, headers });
}

/**
 * 解析小黑盒帖子。
 *
 * @param {{linkId:string, numeric:boolean}} matched
 * @param {object} options `xiaoheiheCookie` 是可选增强项
 */
export async function parseXiaoheihe(matched, options = {}) {
  const { timeoutMs = 20000, maxTextChars = 1200, maxImages = 9, xiaoheiheCookie = '' } = options;
  const url = `https://www.xiaoheihe.cn/app/bbs/link/${matched.linkId}`;
  const referer = url;

  // show_captcha 多半是发得太密，退避重试两次（每次由 throttle 保证间隔）
  let data = await requestTree(matched, { timeoutMs, xiaoheiheCookie, referer });
  for (let attempt = 1; attempt <= 2 && data?.status === 'show_captcha'; attempt += 1) {
    await sleep(attempt * 6000);
    data = await requestTree(matched, { timeoutMs, xiaoheiheCookie, referer });
  }

  const status = data?.status;

  if (status === 'show_captcha') {
    throw new Error(
      '小黑盒这次还是甩了验证码（多半是短时间请求太多）。等一两分钟再让我读一次。'
      + (matched.numeric && !xiaoheiheCookie
        ? '另外数字 id 的帖子需要登录态：在 link-parse.json 里填 xiaoheiheCookie，'
          + '带 pkey 的那种（只带 x_xhh_tokenid 不够，照样弹验证码）。'
        : ''),
    );
  }
  if (status === 'login' || status === 'relogin') throw new Error('小黑盒要求登录态，cookie 可能过期了。');
  if (status && status !== 'ok') throw new Error(`小黑盒返回 ${status}${data?.msg ? `：${data.msg}` : ''}`);

  const link = data?.result?.link;
  if (!link) throw new Error('小黑盒没有返回帖子内容');

  const body = parseBody(link.text, maxTextChars);
  const user = link.user ?? {};
  const images = body.images.slice(0, maxImages);
  const videoUrl = link.has_video ? String(link.video_url ?? '') : '';

  return {
    platform: 'xiaoheihe',
    siteName: '小黑盒',
    kind: videoUrl ? 'video' : (images.length ? 'image' : 'article'),
    url,
    title: String(link.title ?? '').trim(),
    author: String(user.username ?? user.nickname ?? '').trim(),
    description: body.description,
    cover: String(link.video_thumb ?? images[0] ?? ''),
    images,
    videoUrl,
    stats: {
      comments: Number.isFinite(link.comment_num) ? link.comment_num : undefined,
      likes: Number.isFinite(link.link_award_num) ? link.link_award_num : undefined,
    },
    topics: Array.isArray(link.topics) ? link.topics.map((t) => t?.name).filter(Boolean).slice(0, 5) : [],
  };
}

/**
 * dsh-link-parse / lib/platforms/douyin.js
 *
 * 抖音：分享页 `_ROUTER_DATA` 里直接躺着作品数据，不需要签名。
 *
 * ## 是怎么摸出来的（2026-10-19 实测）
 *
 * 抖音有两条路，一条死一条活：
 *
 *   - `www.douyin.com/aweme/v1/web/aweme/detail/` → **403**，
 *     响应体就一句话 `Blocked by ArgusSecurityPlugin Uifid Not Found`。
 *     这个接口要 a_bogus/x-bogus 签名 + uifid cookie，纯 Node 复现不现实。
 *   - `www.iesdouyin.com/share/video/<id>/` → **200，32KB HTML**，
 *     里面 `window._ROUTER_DATA = {...}` 是完整 JSON。
 *
 * 所以走分享页。注意：这个 HTML **只给** data，真正的播放直链还得靠
 * `aweme.snssdk.com/aweme/v1/play/?video_id=<uri>` 换 302（见 `probePlay`）。
 * 但那个换出来的地址带防盗链，QQ 服务器去拉多半 403，所以真正能发出去
 * 还是得本地下载。
 *
 * ## 短链
 *
 * `v.douyin.com/xxx` 是 302 到 www.douyin.com/video/<id> 或 /note/<id>。
 * 展开后取 id 再拼分享页。
 *
 * ## 图集
 *
 * `item.images[]` 有就是图文/图集（note），没有才是视频。抖音的图集也走
 * 同一个 `video_<id>/page` 键，所以入口不用分。
 */

import { fetchText } from '../http.js';

/** 抖音链接识别。短链、直链、精选、音乐都要。 */
export function matchDouyin(text) {
  if (!text) return null;
  const short = text.match(/https?:\/\/(?:v|jx)\.douyin\.com\/[A-Za-z0-9_-]+/);
  if (short) return { kind: 'short', url: short[0] };
  const direct = text.match(
    /https?:\/\/(?:www\.)?(?:douyin\.com\/(?:video|note)\/|iesdouyin\.com\/share\/(?:video|note|slides)\/|jingxuan\.douyin\.com\/m\/(?:video|note|slides)\/)(\d+)/,
  );
  if (direct) return { kind: 'direct', id: direct[1] };
  const live = text.match(/https?:\/\/live\.douyin\.com\/(\d+)/);
  if (live) return { kind: 'live', id: live[1] };
  return null;
}

/** 从 HTML 里抠 `window._ROUTER_DATA = {...}`（截到 </script>）。 */
function extractRouterData(html) {
  const matched = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (!matched) throw new Error('抖音分享页里没找到 _ROUTER_DATA（页面结构可能变了，或被反爬拦了）');
  return JSON.parse(matched[1].trim());
}

/** 在 loaderData 里找 `video_<id>/page` 或 `note_<id>/page`。 */
function pickPage(routerData) {
  const loader = routerData?.loaderData;
  if (!loader || typeof loader !== 'object') return null;
  for (const [key, value] of Object.entries(loader)) {
    if (typeof key === 'string' && /^(video_|note_)/.test(key) && key.endsWith('/page')) {
      if (value && typeof value === 'object') return value;
    }
  }
  return null;
}

/** 选一张没带抖音水印标记的图。 */
function pickImage(image) {
  if (!image || typeof image !== 'object') return '';
  for (const field of ['url_list', 'download_url_list']) {
    const list = image[field];
    if (!Array.isArray(list)) continue;
    for (const url of list) {
      if (typeof url === 'string' && url && !url.includes('-water:')) return url;
    }
  }
  return '';
}

/**
 * 把单条作品数据转成通用结果。
 *
 * @param {object} item aweme item（分享页 item_list[0]）
 */
function buildFromItem(item, id) {
  const author = item.author ?? {};
  const desc = String(item.desc ?? '').trim();
  const images = Array.isArray(item.images)
    ? item.images.map(pickImage).filter(Boolean)
    : [];
  const video = item.video ?? {};
  const cover = pickImage(video.cover ?? video.origin_cover ?? video.dynamic_cover);
  const playAddr = video.play_addr ?? {};
  const playUrls = Array.isArray(playAddr.url_list) ? playAddr.url_list : [];
  // playwm = 带水印版；换成 play 得到无水印（这是抖音公开的老办法）。
  const videoUrl = playUrls[0] ? String(playUrls[0]).replace('/playwm/', '/play/') : '';
  const uri = String(playAddr.uri ?? '');
  const isGallery = images.length > 0;

  return {
    platform: 'douyin',
    kind: isGallery ? 'gallery' : 'video',
    title: desc.split('\n')[0].slice(0, 120) || (isGallery ? '抖音图集' : '抖音视频'),
    author: author.nickname ?? '',
    authorAvatar: pickImage(author.avatar_medium ?? author.avatar_thumb),
    description: desc,
    cover: isGallery ? images[0] : cover,
    images,
    url: `https://www.douyin.com/${isGallery ? 'note' : 'video'}/${id}`,
    videoUrl,
    videoToken: uri,
    durationSec: video.duration ? Math.round(video.duration / 1000) : 0,
    stats: {
      digg: item.statistics?.digg_count ?? 0,
      comment: item.statistics?.comment_count ?? 0,
      share: item.statistics?.share_count ?? 0,
    },
    music: item.music?.title ? { title: item.music.title, author: item.music.author } : null,
  };
}

/**
 * 拿一条抖音作品的原始 item（不给视频直链换 302，那个在 download 里做）。
 */
async function fetchItem(id, options) {
  const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
  const page = await fetchText(shareUrl, {
    ...options,
    mobile: true,
    headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
  });
  if (!page.ok) throw new Error(`抖音分享页 HTTP ${page.status}`);
  const routerData = extractRouterData(page.text);
  const pageData = pickPage(routerData);
  if (!pageData) {
    throw new Error('抖音分享页里没有作品数据（可能是直播间、音乐或已删除的作品）');
  }
  const items = pageData.videoInfoRes?.item_list;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('抖音分享页 item_list 为空（作品可能已删除或仅作者可见）');
  }
  return items[0];
}

/** 展开 v.douyin.com 短链，返回作品 id。 */
async function resolveShortId(url, options) {
  const res = await fetchText(url, { ...options, mobile: true, maxBytes: 256 * 1024 });
  const finalUrl = res.url || '';
  const matched = finalUrl.match(/(?:video|note|slides)\/(\d+)/);
  if (!matched) {
    throw new Error(`抖音短链展开后没找到作品 id：${finalUrl || url}`);
  }
  return matched[1];
}

/** 统一入口。 */
export async function parseDouyin(target, options) {
  if (target.kind === 'live') {
    return {
      platform: 'douyin',
      kind: 'live',
      title: '抖音直播间',
      url: `https://live.douyin.com/${target.id}`,
      description: '抖音直播暂不支持解析（需要签名接口）。',
      images: [],
      videoUrl: '',
    };
  }
  const id = target.kind === 'short' ? await resolveShortId(target.url, options) : target.id;
  const item = await fetchItem(id, options);
  return buildFromItem(item, id);
}

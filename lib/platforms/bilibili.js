/**
 * dsh-link-parse / lib/platforms/bilibili.js
 *
 * B 站：视频（含 b23.tv 短链）、番剧、动态、专栏、直播。
 *
 * ## 只用公开 web 接口，不模拟登录
 *
 * 2026-10-19 实测通过（直连，无需 cookie）：
 *   - `x/web-interface/view?bvid=`  → 标题/UP/封面/时长/分P/简介/播放数
 *   - `x/player/playurl?fnval=1`    → `durl[]` 直接给**音视频合流 mp4**
 *
 * 这里刻意用 `fnval=1`（durl/FLV+MP4 老格式）而不是 `fnval=4048`（DASH）：
 * DASH 把音视频拆成两条，要合流就得拖进 ffmpeg；而 QQ 只能收一个视频文件。
 * durl 给的是合并好的 mp4，拿来就能发。代价是清晰度上限低一些（无 cookie
 * 通常 360P/480P，qn=80 时能摸到 720P），但**能用**比**清晰**重要。
 *
 * ## 防盗链
 *
 * playurl 给的直链带 referer 校验（`upos-*.bilivideo.com` 会看 Referer）。
 * QQ 的服务器去拉是没有我们的 Referer 的，**大概率 403**。所以直链只作为
 * 兜底信息返回；真正能发出去的路子是 `link_download` 下到本地再发。
 */

import {
  fetchJson,
  fetchText,
  formatDuration,
  stripTags,
} from '../http.js';

const API = {
  view: 'https://api.bilibili.com/x/web-interface/view',
  playurl: 'https://api.bilibili.com/x/player/playurl',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  dynamic: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail',
  read: 'https://api.bilibili.com/x/article/viewinfo',
  card: 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail',
  live: 'https://api.live.bilibili.com/room/v1/Room/get_info',
};

/** 从一段文字里挑出 B 站链接与 BV 号。 */
export function matchBilibili(text) {
  if (!text) return null;
  const short = text.match(/https?:\/\/(?:bili2233\.cn|b23\.tv)\/[A-Za-z0-9]+/);
  if (short) return { kind: 'short', url: short[0] };
  const bvid = text.match(/BV[0-9A-Za-z]{10}/);
  const av = text.match(/av(\d+)/);
  const dynamic = text.match(/https?:\/\/(?:t\.bilibili\.com|www\.bilibili\.com\/dynamic)\/(\d+)/);
  if (dynamic) return { kind: 'dynamic', id: dynamic[1] };
  const read = text.match(/https?:\/\/www\.bilibili\.com\/read\/cv(\d+)/);
  if (read) return { kind: 'article', id: read[1] };
  const bangumi = text.match(/https?:\/\/www\.bilibili\.com\/bangumi\/play\/(ep|ss)(\d+)/);
  if (bangumi) return { kind: 'bangumi', type: bangumi[1], id: bangumi[2] };
  const live = text.match(/https?:\/\/live\.bilibili\.com\/(\d+)/);
  if (live) return { kind: 'live', id: live[1] };
  if (bvid) return { kind: 'video', bvid: bvid[0] };
  if (av) return { kind: 'video', aid: av[1] };
  return null;
}

/** 短链 → 展开成完整 bilibili.com 链接（b23.tv 会 302 到 www）。 */
async function expandShort(url, options) {
  const res = await fetchText(url, {
    ...options,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  return res.url || url;
}

/** 封面 URL 补 https 并把裸域名换成 i0 图床（有的接口给 http://i1... 会 403）。 */
function normalizeImage(url) {
  if (!url) return '';
  let out = String(url).trim();
  if (out.startsWith('//')) out = `https:${out}`;
  if (out.startsWith('http://')) out = `https://${out.slice(7)}`;
  return out;
}

/**
 * 拿一个视频的完整信息 + 可下载的直链。
 *
 * @param {{bvid?: string, aid?: string}} target
 */
async function parseVideo({ bvid, aid }, options) {
  const query = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const view = await fetchJson(`${API.view}?${query}`, {
    ...options,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  if (view.code !== 0 || !view.data) {
    throw new Error(`B 站 view 接口返回 ${view.code}：${view.message ?? '未知错误'}`);
  }
  const v = view.data;
  const page = v.pages?.[0] ?? { cid: v.cid, page: 1, part: '' };
  const cid = page.cid;

  const result = {
    platform: 'bilibili',
    kind: 'video',
    title: v.title ?? '',
    author: v.owner?.name ?? '',
    authorUrl: v.owner?.mid ? `https://space.bilibili.com/${v.owner.mid}` : '',
    description: (v.desc ?? '').trim(),
    cover: normalizeImage(v.pic),
    durationSec: v.duration ?? 0,
    durationText: formatDuration(v.duration),
    url: `https://www.bilibili.com/video/${v.bvid}`,
    publishTime: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : '',
    stats: {
      view: v.stat?.view ?? 0,
      like: v.stat?.like ?? 0,
      danmaku: v.stat?.danmaku ?? 0,
      coin: v.stat?.coin ?? 0,
      favorite: v.stat?.favorite ?? 0,
    },
    videoUrl: '',
    videoBackend: '',
    pages: (v.pages ?? []).map((p) => ({
      cid: p.cid,
      page: p.page,
      title: p.part,
      durationSec: p.duration,
    })),
    tags: (v.tags ?? []).map((t) => t.tag_name).filter(Boolean),
    images: [],
  };

  // 直链：尽最大努力拿，拿不到也不算失败（本地下载那条路会自己再取一次）。
  try {
    const qualities = options.bilibiliQuality ?? [80, 64, 32, 16];
    for (const qn of qualities) {
      const play = await fetchJson(
        `${API.playurl}?${v.bvid ? `bvid=${v.bvid}` : `avid=${v.aid}`}&cid=${cid}&qn=${qn}&fnval=1&fourk=1`,
        { ...options, headers: { Referer: `https://www.bilibili.com/video/${v.bvid}` } },
      );
      const durl = play.data?.durl;
      if (play.code === 0 && Array.isArray(durl) && durl.length > 0) {
        result.videoUrl = durl[0].url ?? '';
        result.videoBackend = play.data.format ?? '';
        result.quality = play.data.quality ?? qn;
        if (result.videoUrl) break;
      }
    }
  } catch (error) {
    result.videoUrlError = error.message;
  }

  return result;
}

/** 番剧：ep/ss 先换成对应的 bvid 再走视频流程。 */
async function parseBangumi({ type, id }, options) {
  const url = `https://www.bilibili.com/bangumi/play/${type}${id}`;
  const page = await fetchText(url, {
    ...options,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  const bvid =
    page.text.match(/"bvid"\s*:\s*"(BV[0-9A-Za-z]{10})"/)?.[1]
    ?? page.text.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (!bvid) {
    return {
      platform: 'bilibili',
      kind: 'bangumi',
      title: stripTags(page.text.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
      url,
      note: '没有从番剧页里找到 bvid，只能给个标题。',
      images: [],
    };
  }
  const video = await parseVideo({ bvid }, options);
  return { ...video, kind: 'bangumi', bangumiUrl: url };
}

/** 动态（图文）：t.bilibili.com/<id> 或 www.bilibili.com/dynamic/<id>。 */
async function parseDynamic(id, options) {
  const data = await fetchJson(`${API.dynamic}?id=${id}&features=itemOpusStyle`, {
    ...options,
    headers: { Referer: 'https://t.bilibili.com/' },
  });
  if (data.code !== 0 || !data.data?.item) {
    throw new Error(`B 站动态接口返回 ${data.code}：${data.message ?? '未知错误'}`);
  }
  const item = data.data.item;
  const modules = item.modules ?? {};
  const author = modules.module_author ?? {};
  const major = modules.module_dynamic?.major ?? {};
  const opus = major.opus ?? {};
  const text = opus.summary?.text ?? modules.module_dynamic?.desc?.text ?? '';
  const pics = (opus.pics ?? []).map((p) => normalizeImage(p.url)).filter(Boolean);
  return {
    platform: 'bilibili',
    kind: 'dynamic',
    title: (opus.title ?? text ?? '').split('\n')[0].slice(0, 120),
    author: author.name ?? '',
    authorUrl: author.pub_ts ? `https://space.bilibili.com/${author.mid}` : '',
    description: stripTags(text),
    cover: pics[0] ?? '',
    images: pics,
    url: `https://t.bilibili.com/${id}`,
    publishTime: author.pub_ts ? new Date(author.pub_ts * 1000).toISOString() : '',
    videoUrl: '',
  };
}

/** 专栏：read/cv<id>。 */
async function parseArticle(id, options) {
  const data = await fetchJson(`${API.read}?id=${id}`, {
    ...options,
    headers: { Referer: `https://www.bilibili.com/read/cv${id}` },
  });
  const d = data.data ?? {};
  return {
    platform: 'bilibili',
    kind: 'article',
    title: d.title ?? '',
    author: d.author_name ?? '',
    description: stripTags(d.summary ?? ''),
    cover: normalizeImage(d.banner_url ?? ''),
    images: (d.origin_image_urls ?? []).slice(0, 9).map(normalizeImage).filter(Boolean),
    url: `https://www.bilibili.com/read/cv${id}`,
    publishTime: d.publish_time ? new Date(d.publish_time * 1000).toISOString() : '',
    videoUrl: '',
  };
}

/** 直播间。 */
async function parseLive(id, options) {
  const data = await fetchJson(`${API.live}?room_id=${id}`, {
    ...options,
    headers: { Referer: `https://live.bilibili.com/${id}` },
  });
  const d = data.data ?? {};
  if (!d.room_id) throw new Error(`B 站直播接口返回 ${data.code}：${data.message ?? '房间不存在'}`);
  return {
    platform: 'bilibili',
    kind: 'live',
    title: d.title ?? '',
    author: d.uname ?? '',
    description: stripTags(d.description ?? ''),
    cover: normalizeImage(d.user_cover ?? d.keyframe ?? ''),
    coverDetail: normalizeImage(d.keyframe ?? ''),
    images: [normalizeImage(d.keyframe ?? '')].filter(Boolean),
    url: `https://live.bilibili.com/${d.room_id}`,
    liveStatus: d.live_status === 1 ? '直播中' : '未开播',
    stats: { online: d.online ?? 0, attention: d.attention ?? 0 },
    videoUrl: '',
  };
}

/** 统一入口。 */
export async function parseBilibili(target, options) {
  switch (target.kind) {
    case 'short': {
      const expanded = await expandShort(target.url, options);
      const inner = matchBilibili(expanded);
      if (!inner || inner.kind === 'short') {
        return {
          platform: 'bilibili',
          kind: 'unknown',
          title: '',
          url: expanded,
          description: '短链展开后没认出具体内容类型。',
          images: [],
        };
      }
      return parseBilibili(inner, options);
    }
    case 'video':
      return parseVideo(target, options);
    case 'bangumi':
      return parseBangumi(target, options);
    case 'dynamic':
      return parseDynamic(target.id, options);
    case 'article':
      return parseArticle(target.id, options);
    case 'live':
      return parseLive(target.id, options);
    default:
      throw new Error(`未知的 B 站链接类型：${target.kind}`);
  }
}

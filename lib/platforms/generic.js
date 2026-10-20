/**
 * dsh-link-parse / lib/platforms/generic.js
 *
 * 通用网页：OpenGraph / Twitter Card / `<title>` / `<meta name=description>`
 * 兜底。
 *
 * ## 为什么值得单独写一支
 *
 * 实测（2026-10-19）：知乎正文接口 403、小红书详情页要签名、微博详情 API 要
 * 登录态 —— 这些站**结构化解析做不了**，但它们的分享页往往仍带完整的
 * og: 标签（尤其是被微信/QQ 抓过的页面）。所以「拿到标题 + 摘要 + 封面」这个
 * 下限是有保障的，剩下的交给模型读摘要判断要不要点进去。
 *
 * 这一支也是所有平台的最终 fallback：任何一站解析抛错，都退到这里尽量给点东西。
 */

import { decodeEntities, fetchText, looksBlocked, stripTags } from '../http.js';

/** 顺序有讲究：og 比 twitter 更准，twitter 又比 <title> 更准。 */
function metaContent(html, patterns) {
  for (const pattern of patterns) {
    const matched = html.match(pattern);
    if (matched && matched[1]) {
      const value = decodeEntities(matched[1]).trim();
      if (value) return value;
    }
  }
  return '';
}

function ogTags(html) {
  const m = (prop) =>
    metaContent(html, [
      new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
    ]);
  return {
    title: m('og:title') || m('twitter:title'),
    description: m('og:description') || m('twitter:description') || m('description'),
    image: m('og:image') || m('twitter:image') || m('og:image:url'),
    siteName: m('og:site_name'),
    type: m('og:type'),
    video: m('og:video') || m('og:video:url'),
    url: m('og:url'),
  };
}

/** 站点判定：给结果一个更友好的 platform 名。 */
export function siteOf(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { platform: 'web', siteName: '' };
  }
  const table = [
    ['zhihu.com', 'zhihu', '知乎'],
    ['xiaohongshu.com', 'xiaohongshu', '小红书'],
    ['xhslink.com', 'xiaohongshu', '小红书'],
    ['weibo.com', 'weibo', '微博'],
    ['weibo.cn', 'weibo', '微博'],
    ['tieba.baidu.com', 'tieba', '贴吧'],
    ['xiaoheihe.cn', 'xiaoheihe', '小黑盒'],
    ['mp.weixin.qq.com', 'wechat', '微信公众号'],
    ['github.com', 'github', 'GitHub'],
    ['youtube.com', 'youtube', 'YouTube'],
    ['youtu.be', 'youtube', 'YouTube'],
    ['twitter.com', 'twitter', 'X'],
    ['x.com', 'twitter', 'X'],
    ['bilibili.com', 'bilibili', 'B站'],
    ['douyin.com', 'douyin', '抖音'],
  ];
  for (const [suffix, platform, siteName] of table) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { platform, siteName, host };
  }
  return { platform: 'web', siteName: host, host };
}

/**
 * 抓一个普通网页，抽出能抽到的一切。
 *
 * 不抛错 —— 拿不到就返回一个只带 URL 的结果，让上层决定怎么讲。
 */
export async function parseGeneric(url, options = {}) {
  const { maxTextChars = 1200 } = options;
  const site = siteOf(url);
  const result = {
    platform: site.platform,
    kind: 'web',
    siteName: site.siteName,
    title: '',
    author: '',
    description: '',
    cover: '',
    images: [],
    url,
    videoUrl: '',
    text: '',
  };

  let page;
  try {
    page = await fetchText(url, {
      ...options,
      // 知乎/微博桌面 UA 直接被墙外重定向，移动端反而给完整分享页
      mobile: ['zhihu', 'weibo', 'xiaohongshu', 'tieba'].includes(site.platform),
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
  } catch (error) {
    result.note = `抓取失败：${error.message}`;
    return result;
  }

  if (!page.ok) {
    result.note = `HTTP ${page.status}（可能需要登录或被反爬拦了）`;
    return result;
  }
  if (looksBlocked(page.text)) {
    result.note = '页面看起来是验证/反爬落地页，正文没拿到';
  }

  const html = page.text;
  const og = ogTags(html);
  const titleTag = metaContent(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);

  result.title = og.title || stripTags(titleTag).slice(0, 200);
  result.description = og.description ? stripTags(og.description) : '';
  result.cover = og.image ? decodeEntities(og.image) : '';
  result.siteName = og.siteName || result.siteName;
  result.canonicalUrl = og.url || '';
  if (og.video) result.videoUrl = og.video;

  // 没 og:description 时退到正文首段：只取 body 里的纯文本，截前 maxTextChars。
  if (!result.description) {
    const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
    result.description = stripTags(body).slice(0, maxTextChars);
  } else {
    result.description = result.description.slice(0, maxTextChars);
  }

  // 站点特化：微信公众号能直接从 js 变量里抠标题和作者。
  if (site.platform === 'wechat') {
    const varTitle = html.match(/var msg_title\s*=\s*'([^']*)'/)?.[1]
      ?? html.match(/var msg_title\s*=\s*"([^"]*)"/)?.[1];
    const varAuthor = html.match(/var nickname\s*=\s*"([^"]*)"/)?.[1];
    if (!result.title && varTitle) result.title = decodeEntities(varTitle);
    if (!result.author && varAuthor) result.author = decodeEntities(varAuthor);
  }

  return result;
}

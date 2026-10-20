/**
 * dsh-link-parse / lib/parse.js
 *
 * 链接 → 内容的统一调度层。工具只跟这里打交道。
 *
 * ## 分发顺序（有讲究）
 *
 * 1. **先按域名精确认平台**（B 站/抖音/GitHub），它们有结构化接口，信息最全；
 * 2. **其余一律走通用 OG 兜底**，包括知乎/小红书/微博/贴吧/小黑盒——这些
 *    结构化解析需要登录态或签名，2026-10-19 实测做不了，但 og: 标签还能给
 *    标题+摘要+封面，已经比原始链接强得多；
 * 3. **平台解析抛错时也退到兜底**，并把这个错误记在 `note` 里——绝不因为
 *    某一个站改版就让整个工具报错。
 *
 * ## 为什么要 `deep` 参数
 *
 * 有的模型只想要一句话摘要（省 token），有的想要全文。默认 `deep:false`
 * 只给元数据 + 截断描述；`deep:true` 时额外抓正文/README。
 */

import { fetchText, errorMessage } from './http.js';
import { matchBilibili, parseBilibili } from './platforms/bilibili.js';
import { matchDouyin, parseDouyin } from './platforms/douyin.js';
import { matchGithub, parseGithub } from './platforms/github.js';
import { matchXiaoheihe, parseXiaoheihe } from './platforms/xiaoheihe.js';
import { parseGeneric, siteOf } from './platforms/generic.js';

/** 从任意文本里挑出第一个 URL。 */
export function firstUrl(text) {
  if (!text) return '';
  const matched = String(text).match(/https?:\/\/[^\s<>"'）)】]+/);
  return matched ? matched[0].replace(/[.,;:!?]+$/, '') : '';
}

/** 规范化结果：保证所有字段存在、长度受控。 */
function normalize(result, options) {
  const maxTextChars = options.maxTextChars ?? 1200;
  const maxImages = options.maxImages ?? 9;
  const out = {
    platform: result.platform ?? 'web',
    kind: result.kind ?? 'web',
    url: result.url ?? '',
    title: String(result.title ?? '').slice(0, 300),
    author: String(result.author ?? ''),
    description: String(result.description ?? '').slice(0, maxTextChars),
    cover: String(result.cover ?? ''),
    images: Array.isArray(result.images) ? result.images.filter(Boolean).slice(0, maxImages) : [],
    videoUrl: String(result.videoUrl ?? ''),
    note: result.note ?? '',
  };
  for (const [key, value] of Object.entries(result)) {
    if (key in out) continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * 解析一个链接。
 *
 * @param {string} rawUrl 链接（或含链接的一段文字）
 * @param {object} options 已合并的配置
 * @returns {Promise<object>} 结构化内容
 */
export async function parseLink(rawUrl, options = {}) {
  const url = firstUrl(rawUrl) || rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`这不是一个 http(s) 链接：${rawUrl}`);
  }

  const common = {
    proxyUrl: options.proxyUrl ?? '',
    timeoutMs: options.timeoutMs ?? 20000,
    maxTextChars: options.maxTextChars ?? 1200,
    maxImages: options.maxImages ?? 9,
    githubToken: options.githubToken ?? '',
    bilibiliCookie: options.bilibiliCookie ?? '',
    bilibiliQuality: options.bilibiliQuality ?? [80, 64, 32, 16],
    xiaoheiheCookie: options.xiaoheiheCookie ?? '',
    deep: options.deep === true,
  };
  if (common.bilibiliCookie) {
    common.headers = { Cookie: common.bilibiliCookie };
  }

  // ---- 1. 结构化平台 ----
  const bili = matchBilibili(url);
  if (bili) {
    try {
      return normalize(await parseBilibili(bili, common), common);
    } catch (error) {
      const fallback = await parseGeneric(url, common).catch((e) => ({ note: errorMessage(e) }));
      return normalize({
        ...fallback,
        platform: 'bilibili',
        note: `B 站结构化解析失败（${errorMessage(error)}），已退回通用摘要。`,
      }, common);
    }
  }

  const douyin = matchDouyin(url);
  if (douyin) {
    try {
      return normalize(await parseDouyin(douyin, common), common);
    } catch (error) {
      return normalize({
        platform: 'douyin',
        kind: 'unknown',
        url,
        title: '',
        description: '',
        note: `抖音解析失败：${errorMessage(error)}`,
      }, common);
    }
  }

  // 小黑盒：**失败也不退通用兜底**。它网页是纯前端空壳，og 只有站点名一句
  // 「小黑盒 - 玩家高能聚集地」，退过去等于给模型一条误导性的假标题。
  const heybox = matchXiaoheihe(url);
  if (heybox) {
    try {
      return normalize(await parseXiaoheihe(heybox, common), common);
    } catch (error) {
      return normalize({
        platform: 'xiaoheihe',
        kind: 'unknown',
        url,
        title: '',
        description: '',
        note: errorMessage(error),
      }, common);
    }
  }

  // GitHub 只在能认出 owner/repo 时才走 API，否则（如 gist、marketplace）走兜底。
  if (/(^|\.)github\.com$/i.test(siteOf(url).host ?? '')) {
    const gh = matchGithub(url);
    if (gh && gh.owner && gh.repo) {
      try {
        return normalize(await parseGithub(gh, common), common);
      } catch (error) {
        const fallback = await parseGeneric(url, common).catch(() => ({}));
        return normalize({
          ...fallback,
          platform: 'github',
          note: `GitHub API 失败（${errorMessage(error)}），已退回通用摘要。`,
        }, common);
      }
    }
  }

  // ---- 2. 通用兜底 ----
  const generic = await parseGeneric(url, common);
  return normalize(generic, common);
}

/**
 * 深度正文：把页面正文抽出来（`deep:true` 时用）。
 *
 * 只做最简单的「去脚本/去样式/去标签」，不做 readability 打分 —— 聊天场景
 * 够用，而且不会因为一篇奇怪的文章就吐一堆垃圾。
 */
export async function fetchArticleText(url, options = {}) {
  const res = await fetchText(url, {
    ...options,
    mobile: true,
    headers: { Accept: 'text/html,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = res.text.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? res.text;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim()
    .slice(0, options.maxTextChars ?? 4000);
}

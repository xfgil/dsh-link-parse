/**
 * dsh-link-parse / lib/index.js
 *
 * 把聊天里出现的分享链接变回「内容」：标题、作者、简介、封面、图集、
 * 视频直链，外加一个能把视频/图片下到 QQ 媒体目录的下载工具。
 *
 * ## 为什么不直接装别人现成的
 *
 * 2026-10-19 用户提名了两个仓库：
 *
 *   - `Qfxaile/astrbot_plugin_multi_parser` —— AstrBot 的 Python 插件，
 *     覆盖 B站/抖音/小红书/贴吧/微博/微信/小黑盒，质量不低（分平台模块化、
 *     有测试）。但它是 **AstrBot 插件**：注册的是 AstrBot 的 `@filter`
 *     事件、依赖 AstrBot 的消息对象、用 `httpx` + AstrBot 的配置系统。
 *     本机跑的是 DSH（Node），没有 AstrBot 运行时，搬不过来。
 *   - `wwwzhouhui/video-parser` —— 同样形态，且更偏「下载器」。
 *
 * 结论：**功能可以抄，插件用不了**。这个插件是把前者已验证过的思路
 * （分享页 `_ROUTER_DATA`、B 站 `playurl` durl、og 兜底）用 Node 重写。
 *
 * ## 只做能稳的
 *
 * 实测过、确定能做：B 站（视频/番剧/动态/专栏/直播）、抖音（视频/图集）、
 * GitHub（仓库/issue/PR/用户）。
 * 结构化解析做不了、退化成 og 摘要的：知乎（403）、小红书（详情页要签名）、
 * 微博（API 要登录态）、贴吧、微信、小黑盒 —— 但这些的 og 标签还在，给标题
 * +摘要+封面没问题。
 *
 * 不夸大：工具会明确把「这是结构化解析」还是「只有 og 摘要」写进结果的
 * `note` 里，让模型知道信息有多可信。
 *
 * ## 工具注册写法（DSH 的坑）
 *
 * 这里用 `toolCtx.tools` 上的 `register` 做**裸注册**（不经 defineTool），所以：
 *   1. `parameters` 必须是完整 JSON Schema（`{type:'object', properties:{...},
 *      required:[...]}`），不能写 defineTool 那种扁平映射；
 *   2. `output.schema` 不能用 `{ type: 'json' }`，用只有 `description` 的注解 schema。
 * 详见 ~/.dsh/AGENTS.md 与 `D:\Plugins\_tools\check-tool-schema.mjs`。
 */

import { join } from 'node:path';

import { DEFAULTS } from './config.js';
import { downloadToMedia } from './download.js';
import { pruneImageCache, resolveCacheDir } from './image-cache.js';
import { resolveCookie } from './live-cookie.js';
import { parseLink, firstUrl } from './parse.js';
import { parseDouyin, matchDouyin } from './platforms/douyin.js';
import { parseBilibili, matchBilibili } from './platforms/bilibili.js';

export const name = 'link-parse';

/** `tools` 是唯一硬依赖；拿不到就什么都不注册。 */
export const inject = ['tools'];

/** 合并配置：只认已知字段，未知字段原样保留（方便别人扩展）。 */
function mergeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  // 数组/数字做一次纠正，避免用户写 "80" 这种字符串进来炸掉 B 站请求。
  merged.timeoutMs = Number(merged.timeoutMs) || DEFAULTS.timeoutMs;
  merged.maxTextChars = Number(merged.maxTextChars) || DEFAULTS.maxTextChars;
  merged.maxImages = Number(merged.maxImages) || DEFAULTS.maxImages;
  merged.maxDownloadBytes = Number(merged.maxDownloadBytes) || DEFAULTS.maxDownloadBytes;
  merged.maxImageBytes = Number(merged.maxImageBytes) || DEFAULTS.maxImageBytes;
  // 缓存三项：允许显式 0（= 不按年龄/不按体积删），所以不能套 `|| 默认值`。
  const maxAge = Number(merged.imageCacheMaxAgeMs);
  merged.imageCacheMaxAgeMs = Number.isFinite(maxAge) && maxAge >= 0 ? maxAge : DEFAULTS.imageCacheMaxAgeMs;
  const maxBytes = Number(merged.imageCacheMaxBytes);
  merged.imageCacheMaxBytes = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULTS.imageCacheMaxBytes;
  // autoDownloadImages 允许显式写 0（关掉），所以不能套 `|| 默认值`。
  const auto = Number(merged.autoDownloadImages);
  merged.autoDownloadImages = Number.isFinite(auto) && auto >= 0 ? auto : DEFAULTS.autoDownloadImages;
  // mediaDir 空着也不能让下载功能瘫掉：兜底到 <cwd>/.dsh-media。
  // 这只是「装上去不配也能跑」，真要发到 QQ 还得显式配成 onebot 通道那个目录。
  if (typeof merged.mediaDir !== 'string' || merged.mediaDir.trim() === '') {
    merged.mediaDir = join(process.cwd(), '.dsh-media');
  }
  if (!Array.isArray(merged.bilibiliQuality)) {
    merged.bilibiliQuality = DEFAULTS.bilibiliQuality;
  } else {
    merged.bilibiliQuality = merged.bilibiliQuality
      .map((qn) => Number(qn))
      .filter((qn) => Number.isFinite(qn) && qn > 0);
    if (merged.bilibiliQuality.length === 0) merged.bilibiliQuality = DEFAULTS.bilibiliQuality;
  }
  return merged;
}

/** 一行式结果摘要，给 `render` 和给人看的地方用。 */
function summarize(value) {
  if (value && value.ok === false) return `解析失败：${value.error ?? '未知错误'}`;
  const parts = [];
  if (value?.platform) parts.push(`[${value.platform}/${value.kind ?? 'web'}]`);
  if (value?.title) parts.push(value.title);
  if (value?.author) parts.push(`@${value.author}`);
  if (value?.localPath) parts.push(`→ ${value.localPath}`);
  // 图片已落本地时必须**把路径念出来**：模型只看到 URL 是不会想到去 read_image 的，
  // 而 read_image 又只吃本地路径。这几行就是「她真的看了图」的唯一入口。
  const local = Array.isArray(value?.localImages) ? value.localImages : [];
  if (local.length > 0) {
    parts.push(`｜图已下载（用 read_image 看）：${local.join(' ; ')}`);
  }
  // note 是「这条结果有多可信 / 为什么降级」的说明，摘要里必须带上，
  // 否则模型只看到 [平台/unknown] 就以为解析成功、只是没内容。
  if (value?.note) parts.push(`｜${value.note}`);
  return parts.join(' ') || '（无内容）';
}

/**
 * 把结果里的前 N 张图下载到**缓存目录**，让模型能 `read_image` 真的看到。
 *
 * ## 为什么这件事必须由插件做（2026-10-20）
 *
 * 只给图片 URL 等于没看图：`read_image` 只吃本地路径，而且聊天回合里它还被
 * `dsh-onebot-companion/lib/modules/isolation.js` 的媒体闸限死在 `mediaDir` 之内。
 * 落到别处，模型要么读不到，要么被闸拒。
 *
 * ## 为什么落在 mediaDir 的子目录而不是 mediaDir 根
 *
 * 用户 2026-10-20 问「读完后会删吗？不然我硬盘遭不住」。要能安全地按时间/总量
 * 批量删，就必须把这些图**和语音、表情、聊天图片分开放** —— 在根目录里按 mtime
 * 清理会误删别的东西。子目录又天然满足两道围栏（都是前缀比较）。
 *
 * ## 为什么要逐张 try/catch
 *
 * 图床经常对某一张返回 403/404（防盗链、缩略图过期）。一张失败不该让整条
 * 解析报废 —— 标题和正文还是有效信息。失败的图静默跳过，只统计成功几张。
 *
 * @returns {Promise<string[]>} 成功落盘的本地绝对路径
 */
async function downloadImages(images, cfg, hint, referer) {
  const limit = Math.max(0, Number(cfg.autoDownloadImages) || 0);
  if (limit === 0) return [];
  const dir = resolveCacheDir(cfg.mediaDir, cfg.imageCacheDir);
  const picked = (Array.isArray(images) ? images : []).slice(0, limit);
  const results = await Promise.allSettled(picked.map((url) => downloadToMedia(url, {
    mediaDir: dir,
    maxBytes: cfg.maxImageBytes,
    referer,
    defaultExt: '.jpg',
    nameHint: hint,
  })));
  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value.path);
}

/**
 * 顺手清理一次图片缓存。
 *
 * 挂在每次工具调用**之前**，而不是用 setInterval：插件热重载会重建整棵实例，
 * 定时器会跟着旧实例丢，重载后还可能留下两份同时删文件。
 *
 * 全程不抛错 —— 清理失败不能影响解析本身。
 */
async function pruneCache(cfg, log) {
  if (cfg.imageCacheAutoPrune === false) return;
  try {
    const dir = resolveCacheDir(cfg.mediaDir, cfg.imageCacheDir);
    const result = await pruneImageCache({
      dir,
      maxAgeMs: Number(cfg.imageCacheMaxAgeMs) || 0,
      maxBytes: Number(cfg.imageCacheMaxBytes) || 0,
    });
    if (result.removedByAge > 0 || result.removedBySize > 0) {
      log(`缓存清理：过期 ${result.removedByAge} 张、超量 ${result.removedBySize} 张，释放 ${Math.round(result.freedBytes / 1024)} KB，现留 ${Math.round(result.keptBytes / 1024)} KB`);
    }
  } catch {
    /* 清理出问题绝不能打断解析 */
  }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = mergeConfig(rawConfig);
  if (cfg.enabled === false) return;

  const log = (...args) => {
    try {
      (ctx.logger ?? ctx.root?.logger)?.info?.('[link-parse]', ...args);
    } catch {
      /* 日志失败绝不影响功能 */
    }
  };

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'link_parse',
      description:
        '把一个分享链接解析成内容：标题、作者、简介、封面、图集、视频直链。'
        + '支持 B 站（视频/番剧/动态/专栏/直播，含 b23.tv 短链）、抖音（视频/图集，含 v.douyin.com 短链）、'
        + '小黑盒（帖子/图文，含 share?link_id= 短链）、GitHub（仓库/issue/PR/用户）；'
        + '其余站点（知乎/小红书/微博/贴吧/微信公众号等）退回 OpenGraph 摘要，至少给标题+简介+封面。'
        + '**图文帖的前几张图会自动下载到本地，路径在结果的 localImages 里 —— 想知道图里是什么，'
        + '必须再对每个路径调 read_image，只看 URL 是看不见图的。**'
        + '想把视频/整组图发到 QQ，用 link_download 下到本地再 qq_send_video / qq_send_image。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要解析的链接，也可以是含链接的一整段分享文字（会自动挑出第一个 http 链接）。',
          },
          deep: {
            type: 'boolean',
            description: '是否多抓一点正文（GitHub 会带 README，通用网页会带正文片段）。默认 false。',
          },
        },
        required: ['url'],
      },
      // 注解-only schema = 任意 JSON 对象（裸 register 不接受 { type: 'json' }）。
      output: {
        schema: { description: '解析结果：{ ok, platform, kind, title, author, description, cover, images[], localImages[], videoUrl, note, ... }' },
        render: (_args, value) => [{ type: 'text', text: summarize(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const url = typeof args?.url === 'string' ? args.url : '';
        if (!url.trim()) throw new Error('link_parse: url 必填');
        try {
          // 顺手清一次缓存（按时间 + 总量），不抛错、不影响解析。
          await pruneCache(cfg, log);
          const result = await parseLink(url, {
            ...cfg,
            // cookie 现读 profile 的 cordis.yml：热重载不会重新解析 yml，只信 apply() 那份
            // 就意味着「换 cookie 必须重启宿主」。详见 lib/live-cookie.js 的注释。
            xiaoheiheCookie: resolveCookie(cfg),
            deep: args?.deep === true,
          });
          // 图必须落到本地，否则模型只能看到 URL、根本看不见图（read_image 只吃路径，
          // 且在聊天回合里还被 isolation 的媒体闸限死在 mediaDir 之内）。
          // 下载失败不报错 —— 图床防盗链很常见，标题正文仍然有效。
          let localImages = [];
          if (Array.isArray(result.images) && result.images.length > 0) {
            try {
              localImages = await downloadImages(result.images, cfg, result.title || result.platform, result.url || url);
            } catch {
              localImages = [];
            }
          }
          return { ok: true, ...result, localImages };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            url: firstUrl(url) || url,
          };
        }
      },
    }));

    toolCtx.effect(() => toolCtx.tools.register({
      name: 'link_download',
      description:
        '把链接里的视频/图片下载到本地 QQ 媒体目录，返回本地绝对路径，之后用 qq_send_video / '
        + 'qq_send_image 发出去。QQ 服务器直接抓外链视频多半被防盗链挡（403），所以「先下载再发」是可靠路径。'
        + '支持 B 站视频（走 playurl 拿 mp4）与抖音视频（走 playurl 换 302）。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '作品页链接（B 站视频页 / 抖音分享链接）。',
          },
          kind: {
            type: 'string',
            enum: ['video', 'image'],
            description: '下载视频还是图片。默认 video。',
          },
          index: {
            type: 'number',
            description: 'kind=image 时下载第几张（从 1 开始）。默认 1。',
          },
        },
        required: ['url'],
      },
      output: {
        schema: { description: '下载结果：{ ok, path, bytes, platform, title } 或 { ok:false, error }' },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok === false
            ? `下载失败：${value.error}`
            : `已下载 ${value.path}（${value.bytes} 字节）`,
        }],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const url = typeof args?.url === 'string' ? args.url : '';
        if (!url.trim()) throw new Error('link_download: url 必填');
        const kind = args?.kind === 'image' ? 'image' : 'video';
        const index = Math.max(1, Number(args?.index) || 1);
        try {
          // 顺手清一次缓存（按时间 + 总量），不抛错、不影响解析。
          await pruneCache(cfg, log);
          const parsed = await parseLink(url, { ...cfg, xiaoheiheCookie: resolveCookie(cfg) });
          const hint = parsed.title ? parsed.title.slice(0, 20) : 'linkparse';

          if (kind === 'image') {
            const images = Array.isArray(parsed.images) ? parsed.images : [];
            if (images.length === 0 && parsed.cover) images.push(parsed.cover);
            const target = images[index - 1];
            if (!target) throw new Error(`这条内容只有 ${images.length} 张图，取不到第 ${index} 张`);
            const file = await downloadToMedia(target, {
              mediaDir: cfg.mediaDir,
              maxBytes: cfg.maxDownloadBytes,
              referer: parsed.url || url,
              defaultExt: '.jpg',
              nameHint: hint,
            });
            return { ok: true, ...file, kind, platform: parsed.platform, title: parsed.title };
          }

          const videoUrl = await resolveVideoUrl(parsed, cfg);
          if (!videoUrl) {
            throw new Error('这条内容没有可下载的视频（可能是图文/图集，用 kind=image 试试）');
          }
          const file = await downloadToMedia(videoUrl, {
            mediaDir: cfg.mediaDir,
            maxBytes: cfg.maxDownloadBytes,
            referer: parsed.url || url,
            defaultExt: '.mp4',
            nameHint: hint,
          });
          return { ok: true, ...file, kind, platform: parsed.platform, title: parsed.title };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            url: firstUrl(url) || url,
          };
        }
      },
    }));
  });

  log('ready, mediaDir =', cfg.mediaDir);
}

/**
 * 拿到可直接下载的视频地址。
 *
 * - B 站：`parseLink` 已经带回了 playurl 的 durl 直链，直接用。
 * - 抖音：分享页只给 `video_id`（uri），要用 `aweme.snssdk.com/aweme/v1/play/`
 *   换 302 才拿到真实 mp4。这一步单独做，因为换出来的地址有时效、没必要
 *   放在 parse 里增加延迟。
 */
async function resolveVideoUrl(parsed, cfg) {
  if (parsed.videoUrl) return parsed.videoUrl;
  const target = matchDouyin(parsed.url ?? '');
  if (!target) return '';
  try {
    const detail = await parseDouyin(target, cfg);
    if (detail.videoUrl) return detail.videoUrl;
    if (detail.videoToken) {
      const probe = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(detail.videoToken)}&ratio=1080p&line=0`;
      return probe;
    }
  } catch {
    /* 落到下面统一返回空 */
  }
  return '';
}

export { DEFAULTS, mergeConfig };

// 供测试直接调用（避免为了跑一个函数把插件加载链拖进来）
export { matchBilibili, parseBilibili, matchDouyin };

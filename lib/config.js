/**
 * dsh-link-parse / lib/config.js
 *
 * 配置默认值。宿主不会给我们校验任何字段（`apply(ctx, rawConfig)` 里
 * rawConfig 是用户写在 `cordis.yml` 的 `config:` 下那段原文），所以所有
 * 缺省、类型纠正都集中在这里做一次。
 *
 * 设计上**每个字段都必须有能跑起来的默认值** —— 插件装上去、一句配置都不写
 * 也要能用。需要人手填的只有 cookie/token 这类增强项（不填就降级，不报错）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 出站 UA：移动端 Safari 在 B 站/抖音分享页上拿到的 HTML 最干净。 */
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 桌面 UA：B 站 API 与 GitHub API 用这个更稳（移动端会被降级/挑版本）。 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULTS = {
  /** 总开关。关掉后工具不注册。 */
  enabled: true,

  /**
   * 出站代理。空字符串 = 直连。
   *
   * 2026-10-19 实测：B 站 API、GitHub API、贴吧、抖音分享页在本机**直连全部可达**，
   * 所以默认直连。只有知乎/GitHub 原始文件之类被墙或需要出墙时才填，填的时候
   * 写 `http://127.0.0.1:7899`（那是 dsh-proxy-on-demand 的内核端口）。
   */
  proxyUrl: '',

  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs: 20000,

  /** 描述/正文截断长度（字符）。 */
  maxTextChars: 1200,

  /** 单次最多返回的图片数。 */
  maxImages: 9,

  /**
   * 下载落盘目录。必须落在 `dsh-onebot-qq` 的 `mediaDir` 里面，否则
   * `qq_send_video` / `qq_send_image` 的沙箱围栏会拒收。
   *
   * 空字符串 = 落到 `<cwd>/.dsh-media`。一般都要显式配成 onebot 通道那个目录，
   * 因为围栏是按它比较的；默认值只保证「一句配置不写也能跑起来」。
   */
  mediaDir: '',

  /** 下载体积上限（字节）。QQ 视频/文件上限约 100MB，这里留点余量。 */
  maxDownloadBytes: 80 * 1024 * 1024,

  /** B 站 playurl 清晰度偏好，从高到低挑第一个拿得到的。 */
  bilibiliQuality: [80, 64, 32, 16],

  /**
   * 可选 cookie。B 站不填也能解析 480P/1080P 普通视频；填了才能拿高码率、
   * 大会员清晰度、部分限制级内容。
   */
  bilibiliCookie: '',

  /**
   * 解析图文帖时，自动把前几张图**下载到 `mediaDir`**，让模型能直接 `read_image` 看。
   *
   * ## 为什么要有这个（2026-10-20，用户原话「图你看了吗？看不了想办法让自己能看」）
   *
   * `link_parse` 原来只返回图片 URL。模型拿到 URL 是**看不见图**的 —— `read_image`
   * 只吃本地路径，而且群聊/受限回合里它还被 `isolation` 的媒体闸限死在
   * `mediaDir` 之内。于是「读了一篇图文帖」实际只读到了标题和正文，图全漏了。
   *
   * 落点必须是 `mediaDir`：那正是 `isolation.checkMediaAccess` 与
   * `dsh-onebot-qq` 出站围栏都认的那个目录，下载到这里既读得到、也发得出去。
   *
   * 默认 3 张：够看清一条帖子说什么，又不至于一晚上把媒体目录塞满。
   * 设 0 关闭自动下载（仍可用 `link_download` 手动取）。
   */
  autoDownloadImages: 3,

  /** 自动下载单张图的上限（字节）。图床缩略图一般 100–500 KB。 */
  maxImageBytes: 15 * 1024 * 1024,

  /**
   * 自动下载的图**单独放一个子目录**，不和语音、表情、聊天图片混在一起。
   *
   * 空字符串 = `<mediaDir>\.link-parse-cache`。
   *
   * ## 为什么必须是 mediaDir 的子目录（2026-10-20，用户问「读完后会删吗？不然我硬盘遭不住」）
   *
   * 两道围栏都只认 mediaDir 前缀：
   *   - `dsh-onebot-qq/lib/media.js:resolveContainedPath()` —— 出站发图时把路径
   *     和 roots 都 realpath 后做「目录 + 分隔符」前缀比较，**子目录天然通过**；
   *   - `dsh-onebot-companion/lib/modules/isolation.js:isUnderDir()` —— 同一套语义。
   *
   * 所以放到 mediaDir 之外（比如整个挪去 E 盘）会让这两个闸同时失效：要么读不到，
   * 要么发不出去。要真挪盘，得连 `cordis.yml` 里 onebot-qq 的 `mediaDir` 一起改，
   * 那会把语音、表情、所有聊天图片一起搬走 —— 为了几张帖子配图不值当。
   */
  imageCacheDir: '',

  /**
   * 图片缓存的**总量上限**（字节）。超了就从最旧的开始删，直到降回线内。
   *
   * 150 MB 是有余量的：一张帖图 100–500 KB，一条帖子 3 张，一晚上刷 20 条也不过
   * 二三十兆。真到 150 MB 说明攒了很久，删旧的完全无损 —— 图看过的价值已经兑现了。
   */
  imageCacheMaxBytes: 150 * 1024 * 1024,

  /**
   * 图片缓存的**保留期**（毫秒），默认 3 天。
   *
   * 为什么要给保留期而不是「读完立刻删」：插件根本不知道模型什么时候读完 ——
   * `read_image` 是宿主工具，读完不回话给插件。立刻删会把「下一条消息里还想再看
   * 一眼同一张图」这条路堵死。3 天足够覆盖任何正常的回头查看。
   */
  imageCacheMaxAgeMs: 3 * 24 * 60 * 60 * 1000,

  /**
   * 清理动作**什么时候跑**：每次 `link_parse` / `link_download` 之前顺手做一次。
   *
   * 不用定时器：插件热重载会重建整棵实例，`setInterval` 会跟着丢，还容易在重载后
   * 出现两份定时器同时删文件。挂在工具调用上既不需要生命周期管理，频率也天然合理
   * （没在解析链接就说明没有新图进来）。
   */
  imageCacheAutoPrune: true,

  /**
   * 小黑盒可选 cookie。实测（2026-10-19）：
   *   - 分享短链 `…web/share?link_id=<hex>`、网页 `/app/bbs/link/<hex>` 不用 cookie 就能读；
   *   - 网页 `/app/bbs/link/<纯数字id>` **必须要** `x_xhh_tokenid`，否则一律 show_captcha。
   * 浏览器打开一次 xiaoheihe.cn 就会种这个 cookie，抄 `x_xhh_tokenid=B…` 那段填进来即可
   * （不用登录，随便什么设备 id 都行）。不填就只损失数字 id 这一种链接。
   */
  xiaoheiheCookie: '',

  /** 可选 GitHub token（提高 API 速率上限 60→5000 次/小时）。 */
  githubToken: '',
};

/**
 * 旁挂配置文件（sidecar）的路径。
 *
 * ## 为什么需要它（2026-10-20，踩过一次）
 *
 * `cordis.yml` 里的 `config:` 段**会被宿主改写掉**。实测：写进
 * `- id: link-parse / config: { xiaoheiheCookie: ... }` 之后，宿主某次
 * 保存配置时把整个 `config:` 段删了，节点只剩 `id` 和 `name` 两行 ——
 * 于是 cookie 凭空消失，小黑盒数字 id 又开始 show_captcha，而插件本身
 * 一切正常，极难看出是配置被吃了。
 *
 * 而且热重载也救不了：`dsh-hot-reloader` 重建 fiber 时沿用 `previous.config`
 * （不重读 yml），所以「改 yml → 热重载」这条路本来就是断的。
 *
 * 结论：**需要长期保留的值不该只存在 cordis.yml 里**。插件自己读一份独立
 * 文件，宿主怎么改写 yml 都碰不到它。
 *
 * 优先级：sidecar > cordis.yml（sidecar 是耐久层，写在那儿就是想要它生效）。
 *
 * @returns {string} 绝对路径
 */
export function sidecarPath() {
  const override = process.env.DSH_LINK_PARSE_CONFIG;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const base = home !== '' ? home : '.';
  return `${base}\\.dsh\\link-parse.json`;
}

/**
 * 读旁挂配置。文件不存在、读不动、JSON 坏了 —— 一律返回 `{}`。
 *
 * 刻意**不抛错**：配置坏了不该让插件起不来（那样连诊断都没法做）。
 * 读失败会在宿主日志里留一行 warn（由调用方打印）。
 *
 * @param {(msg: string) => void} [warn]
 * @returns {object}
 */
export function loadSidecar(warn) {
  const file = sidecarPath();
  try {
    // 同步读：apply 是同步的，而且这份文件很小（几百字节）。
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn?.(`旁挂配置不是对象，忽略：${file}`);
      return {};
    }
    return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warn?.(`旁挂配置读取失败（${file}）：${error?.message ?? error}`);
    }
    return {};
  }
}

/**
 * 把值写回旁挂配置（合并，不覆盖别的键）。
 *
 * 用来把「cordis.yml 里写过、但随时可能被宿主吃掉」的值**钉到磁盘上**。
 * 只在检测到 yml 给了新值时才调用，所以不会每次启动都写盘。
 *
 * @param {object} patch
 * @returns {boolean} 是否写入成功
 */
export function saveSidecar(patch) {
  const file = sidecarPath();
  try {
    const merged = { ...loadSidecar(), ...(patch ?? {}) };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

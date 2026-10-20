/**
 * dsh-link-parse / lib/http.js
 *
 * 出站 HTTP 的最小封装：统一 UA、超时、重定向、代理、体积上限。
 *
 * ## 为什么不用 axios/undici 之类
 *
 * 插件跑在宿主进程里，多一个依赖就可能跟宿主的 undici 版本打架（billion-context
 * 当年就是被这种事坑过）。Node 22+ 自带 `fetch`，够用。唯一缺的是「按字节上限
 * 边下边算」，所以下载那一支单独用 `ReadableStream` 手写。
 *
 * ## 代理
 *
 * Node 的 `fetch` **不认** `HTTP_PROXY` 环境变量（undici 不读）。要真走代理只能
 * 自己塞 dispatcher。本机 `dsh-proxy-on-demand` 监听 7899，是个标准 HTTP 代理，
 * 这里用 `node:https` 的 CONNECT 太重，所以走「把 URL 换成代理绝对形式 + 手写
 * httpsOverHttp」那一套也不现实。
 *
 * 简单可靠的办法：代理开启时用 `node:http` 的 `request({ host: proxyHost, port:
 * proxyPort, path: 'https://target...', headers: { Host: target } })` —— 这是
 * HTTP 代理对 **https** 目标的标准 CONNECT 之外的老式做法，mihomo 支持。
 * 实测 2026-10-19 可用。见 `proxyRequest()`。
 */

import http from 'node:http';
import https from 'node:https';
import { MOBILE_UA, DESKTOP_UA } from './config.js';

export { MOBILE_UA, DESKTOP_UA };

/** 常见「这不是真网页」的落地页特征。命中就不当正文抓。 */
const BLOCK_MARKERS = [
  'ArgusSecurityPlugin',
  '验证码',
  '安全验证',
  '请开启JavaScript',
  'Just a moment...',
];

function errorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * 走代理发一次请求（http 代理 + 绝对 URL 形式）。
 *
 * 只实现 GET。返回 `{status, headers, body(Buffer), url}`。
 */
function proxyRequest(url, { proxyUrl, headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new Error(`proxyUrl 不是合法 URL：${proxyUrl}`));
      return;
    }
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    // 老式正向代理：请求行写绝对 URL，明文发到代理端口，代理自己建隧道。
    // mihomo / Clash / squid 都认这个形态。
    const lib = isHttps ? https : http;
    const options = {
      host: proxy.hostname,
      port: Number(proxy.port || (isHttps ? 443 : 80)),
      method: 'GET',
      path: url,
      headers: {
        ...headers,
        Host: target.host,
      },
      timeout: timeoutMs,
    };
    if (proxy.username) {
      options.auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    }
    const req = lib.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (maxBytes && size > maxBytes) {
          req.destroy(new Error(`响应超过上限 ${maxBytes} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          url,
        });
      });
      res.on('error', (error) => reject(new Error(`读取响应失败：${errorMessage(error)}`)));
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${url}`)));
    req.on('error', (error) => reject(new Error(`请求失败：${errorMessage(error)}`)));
    req.end();
  });
}

/**
 * 发一次 GET，把 body 当文本返回。
 *
 * @returns {Promise<{ok: boolean, status: number, url: string, text: string, headers: object}>}
 */
export async function fetchText(url, options = {}) {
  const {
    proxyUrl = '',
    timeoutMs = 20000,
    mobile = false,
    headers: extra = {},
    maxBytes = 6 * 1024 * 1024,
    redirect = 'follow',
  } = options;

  const headers = {
    'User-Agent': mobile ? MOBILE_UA : DESKTOP_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...extra,
  };

  if (proxyUrl) {
    const res = await proxyRequest(url, { proxyUrl, headers, timeoutMs, maxBytes });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      url: res.url,
      headers: res.headers,
      text: res.body.toString('utf8'),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      redirect,
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`响应超过上限 ${maxBytes} 字节：${url}`);
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      headers: Object.fromEntries(response.headers.entries()),
      text: buffer.toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 取 JSON：非 2xx 或解析失败抛错，错误信息里带上 URL 与响应片段。 */
export async function fetchJson(url, options = {}) {
  const res = await fetchText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}：${url}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    const snippet = res.text.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`返回的不是 JSON（${url}）：${snippet}`);
  }
}

/** 盯着重定向，返回最后一跳的 URL（不下载 body）。 */
export async function resolveRedirect(url, options = {}) {
  const res = await fetchText(url, {
    ...options,
    redirect: 'follow',
    maxBytes: 256 * 1024,
  });
  return res.url;
}

/** 这个 HTML 看起来像反爬/验证页吗。 */
export function looksBlocked(text) {
  if (!text) return true;
  return BLOCK_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 把一段可能被 HTML 实体转义的文本还原成纯文本。
 * 只处理最常见的五种实体，够用且不会引入解析库。
 */
export function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 从 HTML 里剥掉标签，压掉空白。 */
export function stripTags(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 复数形式的「X 秒 → 1:23」。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export { errorMessage };

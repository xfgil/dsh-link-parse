import { parseLink } from '../lib/parse.js';

const cases = [
  'https://www.bilibili.com/video/BV1GJ411x7h7',
  'https://b23.tv/BV1GJ411x7h7',
  'https://github.com/Qfxaile/astrbot_plugin_multi_parser',
  'https://www.zhihu.com/question/19550225',
];
for (const url of cases) {
  try {
    const r = await parseLink(url, { maxTextChars: 200 });
    console.log('OK  ', r.platform, r.kind, '|', r.title?.slice(0, 40), '|', r.author, '| cover', !!r.cover, '| video', !!r.videoUrl, '|', r.note || '');
  } catch (e) {
    console.log('FAIL', url, e.message);
  }
}

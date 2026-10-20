/**
 * dsh-link-parse / lib/platforms/github.js
 *
 * GitHub：仓库 / issue / PR / 用户 / 仓库里的文件。
 *
 * 用 REST API 而不是抓 HTML —— HTML 是 React 流式渲染，正文在 `<script>` 里，
 * 抓下来又大又难解析。API 干净、稳定、还带 star/fork 数。
 *
 * 无 token 时 60 次/小时，够聊天用；配了 token 提到 5000。
 */

import { fetchJson } from '../http.js';

const API = 'https://api.github.com';

export function matchGithub(text) {
  if (!text) return null;
  const matched = text.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(issues|pull|blob|tree)\/([^\s?#]+))?/);
  if (!matched) return null;
  return {
    owner: matched[1],
    repo: matched[2],
    kindWord: matched[3] ?? '',
    rest: matched[4] ?? '',
    url: matched[0],
  };
}

function ghOptions(options) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
  return { ...options, headers: { ...headers, ...(options.headers ?? {}) } };
}

export async function parseGithub(target, options) {
  const opts = ghOptions(options);
  const { owner, repo, kindWord, rest } = target;

  // issue / PR
  if ((kindWord === 'issues' || kindWord === 'pull') && rest) {
    const number = rest.split('/')[0];
    const issue = await fetchJson(`${API}/repos/${owner}/${repo}/issues/${number}`, opts);
    return {
      platform: 'github',
      kind: issue.pull_request ? 'pr' : 'issue',
      title: issue.title ?? '',
      author: issue.user?.login ?? '',
      description: (issue.body ?? '').slice(0, options.maxTextChars ?? 1200),
      cover: '',
      images: [],
      url: issue.html_url ?? target.url,
      publishTime: issue.created_at ?? '',
      stats: {
        comments: issue.comments ?? 0,
        reactions: issue.reactions?.total_count ?? 0,
      },
      labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      state: issue.state ?? '',
    };
  }

  // 文件 / 目录：只给路径与大小，不抓内容（内容可能是二进制）
  if ((kindWord === 'blob' || kindWord === 'tree') && rest) {
    return {
      platform: 'github',
      kind: 'file',
      title: `${owner}/${repo}/${rest}`,
      author: owner,
      description: `仓库 ${owner}/${repo} 里的${kindWord === 'blob' ? '文件' : '目录'}：${rest}`,
      cover: '',
      images: [],
      url: target.url,
    };
  }

  // 用户/组织
  if (!repo || repo === '') {
    const user = await fetchJson(`${API}/users/${owner}`, opts);
    return {
      platform: 'github',
      kind: 'user',
      title: user.name ? `${user.name} (@${user.login})` : `@${user.login}`,
      author: user.login ?? '',
      description: user.bio ?? '',
      cover: user.avatar_url ?? '',
      images: [user.avatar_url].filter(Boolean),
      url: user.html_url ?? target.url,
      stats: { repos: user.public_repos ?? 0, followers: user.followers ?? 0 },
    };
  }

  // 仓库
  const data = await fetchJson(`${API}/repos/${owner}/${repo}`, opts);
  const images = [];
  const readme = await fetchJson(`${API}/repos/${owner}/${repo}/readme`, opts).catch(() => null);
  let readmeText = '';
  if (readme?.content) {
    try {
      readmeText = Buffer.from(readme.content, readme.encoding === 'base64' ? 'base64' : 'utf8')
        .toString('utf8')
        .slice(0, options.maxTextChars ?? 1200);
    } catch {
      readmeText = '';
    }
  }
  return {
    platform: 'github',
    kind: 'repo',
    title: data.full_name ?? `${owner}/${repo}`,
    author: data.owner?.login ?? owner,
    description: (data.description ?? '').trim() || readmeText.split('\n').find((l) => l.trim()) || '',
    readme: readmeText,
    cover: data.owner?.avatar_url ?? '',
    images,
    url: data.html_url ?? target.url,
    publishTime: data.created_at ?? '',
    stats: {
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      issues: data.open_issues_count ?? 0,
      watchers: data.watchers_count ?? 0,
    },
    language: data.language ?? '',
    topics: data.topics ?? [],
    license: data.license?.spdx_id ?? '',
    updatedAt: data.updated_at ?? '',
  };
}

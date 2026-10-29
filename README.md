# dsh-link-parse

把聊天里出现的分享链接解析成**内容**——标题、作者、简介、封面、图集、视频直链——并支持把视频/图片下载到本地媒体目录再发出去。

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的插件。起因很具体：QQ 群里别人丢一条 `b23.tv` 短链过来，模型能看到 URL、能"读到"一层跳转壳的 HTML，但 B 站页面是 JS 渲染的，它实际什么都没看见，于是只能含糊地回一句"看起来不错"。这个插件就是为了让它真能看见。

## 两个工具

### `link_parse`

把一个链接解析成结构化内容。

| 平台 | 支持范围 |
| --- | --- |
| B 站 | 视频 / 番剧 / 动态 / 专栏 / 直播，含 `b23.tv` 短链 |
| 抖音 | 视频 / 图集，含 `v.douyin.com` 短链 |
| 小黑盒 | 帖子 / 图文，含 `share?link_id=` 短链 |
| GitHub | 仓库 / issue / PR / 用户（README 可选一并带出） |
| 其它站点 | 退回 OpenGraph 摘要，至少给标题 + 简介 + 封面 |

参数只有一个 `url`，可以直接把整段分享文字丢进来（会自动挑第一个 http 链接）。

图文帖的前几张图会**自动下载到本地**，路径在返回值的 `localImages` 里——因为 `read_image` 只吃本地路径，光有 URL 是看不见图的。想知道图里是什么，得再对每个路径调一次 `read_image`。

### `link_download`

把视频/图片下载到媒体目录，返回本地绝对路径。

QQ 服务器直接抓外链视频多半被防盗链挡（403），所以"先下载再发"是可靠路径。下完用 `qq_send_video` / `qq_send_image` 发出去。

## 安装

作为 profile 依赖装进你的 DSH profile：

```bash
cd ~/.dsh/profiles/<你的profile>
pnpm add link:D:/path/to/dsh-link-parse
```

或者在 `cordis.yml` 里直接挂：

```yaml
- id: link-parse
  name: dsh-link-parse
```

一句配置都不写也能跑——每个字段都有能工作的默认值。

## 配置

全部可选。写在 `cordis.yml` 的 `config:` 下：

```yaml
- id: link-parse
  name: dsh-link-parse
  config:
    mediaDir: '/path/to/your/media-dir'   # 与 dsh-onebot-qq 的 mediaDir 保持一致
    bilibiliCookie: ''
    xiaoheiheCookie: ''
    githubToken: ''
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后工具不注册。 |
| `proxyUrl` | `''` | 出站代理，空 = 直连。B 站 / GitHub / 贴吧 / 抖音分享页在境内都能直连。 |
| `timeoutMs` | `20000` | 单次 HTTP 超时。 |
| `maxTextChars` | `1200` | 描述/正文截断长度。 |
| `maxImages` | `9` | 单次最多返回的图片数。 |
| `mediaDir` | DSH 侧配置 | 下载落盘目录，**必须**落在 onebot 通道的 `mediaDir` 之内，否则发送时被沙箱围栏拒收。 |
| `maxDownloadBytes` | 80 MB | 下载体积上限。 |
| `bilibiliQuality` | `[80, 64, 32, 16]` | playurl 清晰度偏好，从高到低挑第一个拿得到的。 |
| `bilibiliCookie` | `''` | 填了才能拿高码率 / 大会员清晰度 / 部分限制级内容。 |
| `autoDownloadImages` | `3` | 自动下载前几张图。设 0 关闭。 |
| `imageCacheDir` | `<mediaDir>\.link-parse-cache` | 缓存的子目录。**必须是 mediaDir 的子目录**——两道沙箱围栏都是前缀比较。 |
| `imageCacheMaxBytes` | 150 MB | 缓存总量上限，超了从最旧的删。 |
| `imageCacheMaxAgeMs` | 3 天 | 缓存保留期。 |
| `imageCacheAutoPrune` | `true` | 每次调用工具前顺手清理一次（不用定时器，热重载不会漏两份）。 |
| `xiaoheiheCookie` | `''` | 数字 id 形式的小黑盒链接必须要 `x_xhh_tokenid`，否则一律 show_captcha。 |
| `githubToken` | `''` | 把 GitHub API 速率上限从 60 提到 5000 次/小时。 |

### 旁挂配置文件（sidecar）

`cordis.yml` 里的 `config:` 段**会被宿主改写**。实测过一次：写进去的 cookie 在某次保存配置后整个段被删掉，节点只剩 `id` 和 `name` 两行，于是小黑盒数字 id 又开始 show_captcha。

所以敏感的增强项（cookie / token）也可以放在旁挂文件里，插件启动时读它，不依赖 yml 是否被保留。路径见 `lib/config.js` 的 `sidecarPath()`。

## 设计上的几个选择

**为什么默认直连、不挂代理**：2026-10-19 实测，B 站 API、GitHub API、贴吧、抖音分享页在本机全部直连可达。只有知乎之类被墙的才需要填 `proxyUrl`。

**为什么图要下到 mediaDir 里面**：`dsh-onebot-qq` 的 `resolveContainedPath()` 和 `dsh-onebot-companion` 的 `isUnderDir()` 都是 realpath 后的"目录 + 分隔符"前缀比较，子目录天然通过。挪到 mediaDir 之外会让"读得到"和"发得出去"这两件事同时失效。

**为什么缓存不读完就删**：插件根本不知道模型什么时候读完——`read_image` 是宿主工具，读完不回话给插件。立刻删会把"下一条消息里还想再看一眼同一张图"这条路堵死。3 天足够覆盖任何正常的回头查看。

**为什么清理挂在工具调用上、不用定时器**：插件热重载会重建整棵实例，`setInterval` 跟着丢，重载后还可能出现两份定时器同时删文件。挂在工具调用上不需要生命周期管理，频率也天然合理。

## 安全边界

`link_parse` 能访问任意 URL，包括 `http://127.0.0.1:6099/webui?token=…` 这种本机面板。所以它**不该被无条件交给不受信任的一方**。

如果你用 `dsh-onebot-companion`，那里的 `isolation` 模块会把群聊里非管理员发言的那一轮划成受限回合，`link_parse` / `link_download` / `web_fetch` 共用同一条 `checkLinkAccess` 边界：只认本轮入站文本里出现过的公网地址，本机/内网地址一律拒。

## 支持的 DSH 版本

| 项 | 范围 | 依据 |
| --- | --- | --- |
| DSH | **>= 0.2.0** | 只用到 `inject`、`ctx.inject(['tools'])`、`tools.register` 三个基础接口，0.2 起未变 |
| Node | **>= 22** | `package.json` 的 `engines` |
| 宿主包 | **不依赖** | 只用 Node 内置模块（`fs` / `http` / `https` / `stream` / `crypto`） |

实测环境：DSH `0.2.1-rc.2`（Windows x64）。

**不依赖任何 `@deepseek-ai/*` 包**，所以不会因为宿主包升级而挂。但它调用的那三个接口如果哪天改名，就得跟着改。

## 免责声明

**这个工具会抓取第三方平台的内容。请只用在你本来就有权查看的内容上。**

1. **遵守平台条款。** 多数平台的服务条款限制自动化访问。自己日常用通常没人管；**拿它做批量抓取、镜像站点、或对外提供服务，那是另一回事**，风险和本项目无关，由使用者承担。
2. **内容不是你的。** 解析出来的标题、作者、封面、视频直链，版权属于原作者和平台。下载下来自己看是一回事，再分发是另一回事。
3. **不要用它绕开付费墙或登录限制。** `live-cookie.js` 是给「你自己已经登录的账号」用的，不是用来伪造身份。
4. **它不该被无条件交给不受信任的一方。** `link_parse` 能访问任意 URL，包括本机面板地址。在群里跑务必配合 `dsh-onebot-companion` 的 `isolation` 模块（见上节）。

软件按 MIT 协议「按现状」提供，不对使用后果作任何担保。

## 开发

```bash
node test/smoke.mjs           # 四个平台各打一发
node test/download-test.mjs   # 下载链路
node test/plugin-test.mjs     # 工具注册形状
```

## License

MIT

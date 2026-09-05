# Tursom Log

Tursom Log 是一个中文优先的个人技术博客，文章使用标准 Markdown 和 Git 管理，站点由 Astro 生成静态 HTML。

## 本地开发

需要 Node.js 22+、pnpm 11+，以及用于构建 Mermaid 的 Chromium：

```bash
pnpm install
pnpm exec playwright install --only-shell chromium
pnpm dev
```

打开 <http://localhost:4321>。

构建检查：

```bash
pnpm check
pnpm build
```

发布前可在本地预览后运行 Lighthouse，性能、可访问性和 SEO 以 95 分为验收参考，不作为 CI 阻断条件：

```bash
pnpm preview --host 127.0.0.1 &
pnpm dlx lighthouse http://127.0.0.1:4321/ --view
```

## 写文章

文章放在 `src/content/posts/`，每篇文章使用最小 Front Matter：

```yaml
---
title: 文章标题
slug: english-slug
summary: 一句话摘要
publishedAt: 2026-08-17
updatedAt: 2026-08-18
tags:
  - Go
aiAssisted: true
cover: null
---
```

由 AI 承担主要执笔工作的文章必须设置 `aiAssisted: true`，站点会在文章列表和详情页显示“AI 辅助创作”标记。未设置时默认为 `false`。

私有文章设置 `private: true`（默认 `false`）。匿名访问时，文章不会出现在首页、归档、标签、RSS 或站点地图中；输入站点密钥后可以在完整列表中阅读。生产构建把私有正文移入受保护的内部目录，必须经过 Go 鉴权入口访问，不能直接公开 Astro 开发服务器或静态构建目录。已上线文章改为私有后，还需重新构建部署并清除旧页面及订阅等缓存。具体规则见“私有资源访问控制”。

草稿使用 `draft/*` 分支；合并到 `master` 才会进入正式构建。Mermaid 使用 `mermaid` fenced code block，构建阶段生成静态 SVG。

## 导入图书

图书使用独立的 `src/content/books/` 集合，不会出现在普通文章首页、归档、标签或 RSS 中。每本书有一个书籍详情页和多个独立章节页，入口为 `/books/`。书架按作品或系列分组，并在浏览器内提供书名、作者、版本筛选；打开章节后会把每本书最后阅读的位置保存在当前浏览器的 `localStorage` 中。

每本书的 Front Matter 需要提供以下书架字段：

- `category`：`works` 或 `textbook`
- `groupSlug`、`groupTitle`：同一作品、系列或不同版本使用相同值
- `groupOrder`：顶层书架分组顺序，同组必须一致
- `seriesOrder`：组内册次或版本顺序

单本书也使用独立的 `groupSlug`。构建时会拒绝同一 `groupSlug` 下标题、分类或排序不一致的内容。

仓库提供 EPUB 离线导入器。它读取本地 EPUB 的 `content.opf`、`toc.ncx`、XHTML 正文和图片，生成书籍 Markdown、章节 Markdown、封面/插图和导入报告：

```bash
pnpm import:book /path/to/book.epub
```

未传路径时，命令使用当前工作区约定的《枪炮、病菌与钢铁》 EPUB 路径。导入器只清理并重建目标书籍自己的 `src/content/books/<slug>/` 和 `public/images/books/<slug>/`，不会修改原始 EPUB、其他书籍或普通文章。原始电子书文件不应提交到 Git。

图书 Front Matter 必须保留 `sourceUrl` 和 `rightsNotice`。公开部署前应确认正文和插图的转载范围；导入器不绕过 Cloudflare、人机验证或其他访问控制。

《资本论》双语版由专用导入器 `pnpm import:capital` 生成：中文译本来自中文马克思主义文库（据人民出版社 1972 年及 1975 年版整理），德文原文来自 mlwerke.de 的 GitHub 镜像（MEW 第 23—25 卷，固定提交）。两者生成 `capital-zh` 与 `capital-de` 两个书籍版本，目录按卷分组，同章互链；导入器只重建这两个书籍自己的目录，不修改其他书籍或文章。中文译本的转载权利仍须按所在地法律与来源站说明核验。

《毛泽东选集》第一至第五卷由专用导入器 `pnpm import:mao` 生成。正文来自 MaoZeDongAnthology 的固定 Git 提交，共 229 篇，按五卷分组；导入器只重建 `src/content/books/mao-selected-works/`，不会修改其他图书或文章。来源项目未声明许可证，公开部署前须另行核验原作及电子文本的转载授权。

《三体》三部曲（地球往事三部曲）由专用导入器 `pnpm import:santi` 生成：正文来自努努书坊（kanunu8.com）的《三体（全三册）》在线阅读页面，分别整理为 `three-body`、`three-body-dark-forest`、`three-body-deaths-end` 三册（《三体》35 个标题章节 + 后记、《黑暗森林》序章 + 上中下部、《死神永生》六部），同一书架分组并设为私密阅读；导入器只重建这三册自己的 `src/content/books/` 目录，不修改其他图书或文章。整理时会统一半角标点为全角并修正流传文本中已确认的转录错误（如 1/l 混淆、“威摄/威慑”“执道/轨道”）。三体系列仍在版权保护期内，本整理版仅供站点主人私人阅读，请勿公开传播或另作他用；源站改版会触发导入器的严格校验，需要更新脚本顶部的结构声明后才能再次导入。

Xeelee Sequence（Stephen Baxter 的科幻系列）私密英文书架由专用导入器 `pnpm import:xeelee` 生成。默认从项目的 `tmp/` 读取用户提供的 EPUB/PDF，导入 `Raft`、`Timelike Infinity`、`Flux`、`Ring`、`Vacuum Diagrams`、`Mayflower II`、`Xeelee: Endurance`、`Xeelee: Vengeance` 与 `Xeelee: Redemption` 共 9 本书；`Timelike Infinity` 的 PDF 提取依赖系统命令 `pdftotext`。AZW3 合集中的前四册与单册素材重复，因此不会重复生成书目，只用于交叉校对文本完整性。脚本清理原电子书中的封面页、目录、广告和出版信息，按 EPUB spine/NCX 或 PDF 章节生成 Markdown 和导入报告；可确定的底本/转换错误以带命中次数检查的规则修正，并在替换输出前检查最小章节数与字符数、乱码、广告残留、无效相对链接和重复章节 slug。每册均设置 `private: true`、`language: en`。原始电子书保留在 Git 忽略的 `tmp/`，不会复制到仓库；也可用 `pnpm import:xeelee -- --from-dir /path/to/files` 指定目录。`pnpm import:xeelee -- --free` 仍可单独重建 Infinity Plus 上作者授权免费发布的《Raft》原始短篇（`xeelee-raft`）。

Xeelee 中文版采用保留英文原文的独立书目与逐章双向互链。当前 `raft-zh`（《筏》）、`timelike-infinity-zh`（《类时无限》）、`flux-zh`（《通量》）与 `ring-zh`（《环》）均为完整的非正式中文试译；术语与拟用中文书名记录在 `docs/translations/xeelee-glossary.md`。中文译文同样设置 `private: true`，且属于受版权保护作品的衍生文本，不因私密访问而自动取得翻译或传播授权。

中学政治课本由专用导入器 `pnpm import:textbooks` 生成：初中《道德与法治》六三制各册与高中《思想政治》必修/选择性必修各册，正文来自国家中小学智慧教育平台（basic.smartedu.cn）官方电子教材 PDF 的文本层，按「单元 / 课 / 框」结构整理成书籍与章节 Markdown，封面取 PDF 首页。官方电子教材版权页及每页均标注“仅供个人学习使用，未经授权不得另做他用”，本仓库整理版本同样仅限本地个人学习使用，请勿公开部署或传播；正文插图未收录。个别册次（如最新修订版下册）在平台上仅存于需登录鉴权的存储桶，导入器会跳过并在结束时报告，届时请更换为公开的册次或以其他方式获取。

### 私有资源访问控制

博客和图书共用同一把访问密钥，继续使用 `TURBLOG_BOOK_ACCESS_PASSWORD` 环境变量及原有签名算法，不需要另设博客密码。博客 Front Matter 的 `private: true` 现在表示“仅授权访问”，而不是永远不生成：匿名首页、归档、标签页、RSS 和 sitemap 不包含该文章的标题、简介、标签或数量；直接访问私有博客与不存在的文章返回同样的通用 404。输入密钥后，首页、归档和标签页显示包含私有文章的完整列表，书架也同时解锁。

全站“输入密钥”入口为 `/_access/`；原有 `/books/_access/` 仍可使用。私有博客提供“复制本文分享链接”，链接只授予该文章及关联私有图片的访问权，不开放完整列表、其他文章或图书。书籍整本及单章分享的格式和范围保持不变。

构建出的私有博客正文保存在 `_internal/posts/`，私有专用媒体保存在 `_internal/assets/`，普通静态路径下不保留副本。Go 根据独立的 `post-access-manifest.json` 鉴权后通过内部内容入口读取。共用的公开媒体仍公开；私人素材不应同时被公开文章引用，也不应放在公开 Git 或公开镜像中。

### 图书访问控制

书架 `/books/` 默认只展示公开书籍。私有书籍的书名、作者、版本、数量、链接和简介均不进入公开书架 HTML、本地搜索或公开 sitemap；分组和总数只根据当前可见书籍计算，未解锁时也不会显示本地保存的私有阅读记录。点击书架上的“输入密钥”，验证后直接返回包含所有书籍的完整书架。

访问规则由书籍自身的 `book.md` 元数据决定：设置 `private: true` 的书籍，其详情页 `/books/<book-slug>/`、章节页 `/books/<book-slug>/<chapter-slug>/` 和 `/images/books/<book-slug>/` 下的图片均由 Go 服务强制鉴权。未授权的私有页面与不存在的图书地址返回相同的通用 404，不再以“已锁定”暴露资源存在。未设置或设置为 `false` 的图书仍直接公开。Astro 构建时会生成内部完整内容目录和访问清单，Go 从同一镜像读取它们；内部目录不能通过 HTTP 读取。

新增需要保护的书籍时，在对应的 `src/content/books/<book-slug>/book.md` Front Matter 中设置：

```yaml
private: true
```

受保护页面先使用 60 万轮 `PBKDF2-HMAC-SHA-256` 从 `TURBLOG_BOOK_ACCESS_PASSWORD` 派生签名密钥，再以 `HMAC-SHA-256(派生密钥, 页面规范路径)` 生成页面令牌。详情页令牌授予同一本书的详情和全部章节访问权，适合分享整本书；章节页令牌仍只允许打开对应章节。慢速派生能提高离线猜测分享令牌的成本，但不能弥补过弱的口令。

在 `/books/_access/` 输入密钥会换取持续 30 天的 HttpOnly 主人 Cookie，一次解锁完整书架及所有受保护的图书内容。私有图书详情页提供“复制全书分享链接”，朋友打开后可阅读该书详情和所有章节；章节页的“复制本章分享链接”只授予当前章节权限，不会解锁完整书架或其他书籍。令牌算法保持不变，已有分享链接继续有效。分享链接的 fragment 不会发送给 Nginx、Cloudflare 或外部站点，并会在完成授权后从地址栏清除。

在 `.env` 中配置至少 8 个字符的可记忆口令，建议使用由多个无关词组成的长短语，而不是常见单词、生日或连续数字。修改书籍的 `private` 元数据后重新构建并部署镜像即可，不需要修改环境变量。可从书架输入密钥后打开图书或章节并复制分享链接，也可在项目目录生成：

```bash
pnpm book:share /books/daode-yu-fazhi-7-shang/
pnpm book:share /books/daode-yu-fazhi-7-shang/daode-yu-fazhi-7-shang-lesson-01/
```

`book:share` 从对应书籍的 `book.md` 读取 `private` 标记，并从 `.env` 读取 `TURBLOG_BOOK_ACCESS_PASSWORD` 和 `PUBLIC_SITE_URL`；它会拒绝为公开书籍生成分享链接。轮换主密码会立即使所有受保护图书页面的旧分享链接和 Cookie 失效。生产环境必须使用 HTTPS，否则浏览器的 Web Crypto 和安全传输边界无法成立。

这是一层线上访问控制，不会加密 Git 历史、Markdown 源文件、Docker 镜像或图片源文件。当前图书文件已被 Git 跟踪，公开仓库或公开 GHCR 镜像仍会泄露资源清单和正文；真正的私人数据必须移出公开 Git 历史并使用私有镜像或私有内容存储。已经被爬虫收录、缓存或经分享链接公开的资料也无法通过本次改版撤回。不要把 Astro 开发服务器、`dist/` 静态目录或内部 `blog` 容器直接暴露到公网，线上必须经过 Go 鉴权入口。

公开 sitemap 仅用于搜索引擎；Go 默认读取 `_internal/content-catalog.xml` 完整目录。修改 `private` 标记后必须重新构建，不能只替换公开 sitemap。升级后若旧浏览器 Cookie 无法加载图片，重新输入一次密钥或重新打开原分享链接即可换取覆盖图片和统计接口的新 Cookie。

真实浏览器权限回归需要先启动 Go/Nginx 服务，再运行：

```bash
TURBLOG_ACCESS_TEST_URL=http://127.0.0.1:8080 \
TURBLOG_ACCESS_TEST_PASSWORD='your-test-password' \
pnpm exec playwright test tests/book-access-live.spec.ts tests/post-access-live.spec.ts
```

## 访问统计后端

`server/` 是 Tursom Log 的通用 Go 后端。文章访问统计是第一个模块；以后站长登录、管理后台和内容操作也由这个服务承载。当前公开接口只有批量指标查询：

```http
POST /api/v1/analytics/metrics/query
Content-Type: application/json

{
  "metric": "article_unique_views",
  "subject_type": "article",
  "subject_ids": ["go-atomic-generics", "row-linked-list"]
}
```

一次最多查询 100 个 slug。响应中的 `values` 包含已知文章的总访问量（包括浏览器、爬虫、脚本和未知客户端），`unknown` 返回 sitemap 中不存在的 slug。公开页面每页只发一次批量请求。

图书章节使用同一个接口，但 subject type 和 metric 独立：`book_chapter` / `book_chapter_unique_views`，subject id 为 `<book-slug>/<chapter-slug>`。文章和图书章节的统计不会相互混淆。未授权的私有文章和私有章节均列入 `unknown`，不会泄露资源存在或访问量；主人与有效分享链接持有者可以查询各自有权访问的资源。

Go 服务代理 `/posts/*`，只在 sitemap 中的文章收到成功的 `GET 200 text/html` 响应后计数。`HEAD`、重定向、404 和非 HTML 响应不会计数。同一 IP 和 User-Agent 对同一文章每天最多计数一次；日期桶使用 `Asia/Shanghai`，事件时间使用 UTC。原始 IP 和完整 User-Agent 不会写入数据库。生产 Compose 显式允许 Go 信任入口代理写入的 `X-Real-IP`；本地直连模式默认忽略客户端提供的代理头。

本地运行 Go 测试：

```bash
cd server
go test -race ./...
```

## 容器部署

Dockerfile 同时构建 Astro 静态站点和 `turblog-server`，并将两者放入同一个 Nginx 运行镜像。Compose 使用该镜像启动 `blog` 和 `server` 两个容器；首页、归档、标签、登录、文章、图书、图片和附件经过 Go，后端按 Cookie 决定可见内容与缓存策略。普通公开文章在 Go 不可用时仍可回退到 `blog`，私有博客正文已从普通静态路径移除，因此不会被回退公开；个性化列表、图书和受保护媒体不做静态回退。

本地 Compose 默认监听 `8080`：

```bash
export TURBLOG_VISITOR_HASH_KEY="$(openssl rand -hex 32)"
export TURBLOG_BOOK_ACCESS_PASSWORD='choose-a-memorable-passphrase'
docker compose -f docker-compose.local.yml pull
docker compose -f docker-compose.local.yml up -d
```

GitHub Actions 在 `master` 推送时构建并推送 GHCR 镜像。需要 VPS 自动更新时，才配置以下 Secrets：

- `DEPLOY_WEBHOOK_URL`
- `DEPLOY_WEBHOOK_TOKEN`

未配置这两个 Secrets 时，镜像仍会正常构建并推送，Workflow 会跳过 VPS 通知并给出 warning，不会因此失败。

部署所需的 Actions Variable：`PUBLIC_SITE_URL`。它用于生成 canonical、RSS 和 sitemap；本地开发未设置时使用 `http://localhost:4321`。页面统一从 `/api/v1` 查询后端；镜像构建参数 `PUBLIC_API_BASE_PATH` 可在需要时覆盖该前缀。

### 首次启用后端

生产环境第一次启用统计前，先把新版 `docker-compose.yml` 和 `.env.example` 同步到 VPS。旧 Compose 不认识 `server` 服务，仅触发 Watchtower Webhook 不会创建它。

在 Compose 文件所在目录创建或更新 `.env`：

```bash
WATCHTOWER_HTTP_API_TOKEN=replace-with-a-long-random-token
TURBLOG_VISITOR_HASH_KEY=replace-with-output-of-openssl-rand-hex-32
TURBLOG_BOOK_ACCESS_PASSWORD=choose-a-memorable-passphrase
```

用 `openssl rand -hex 32` 生成 `TURBLOG_VISITOR_HASH_KEY`；`TURBLOG_BOOK_ACCESS_PASSWORD` 使用至少 8 个字符且便于记忆的长短语。两者都要长期保存且不要提交。书籍 Front Matter 的 `private` 字段是唯一决定哪些书需要鉴权的标记；构建出的访问清单缺失或无效时 Go 服务会拒绝启动。轮换统计密钥会让同一访客在轮换当天可能再次计数；轮换图书口令或令牌派生版本会使全部受保护图书页面的分享链接失效。然后拉取镜像并同步服务：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

可以从仓库中的 `.env.example` 开始填写；真实 Token 不要提交到 Git。

将 `DEPLOY_WEBHOOK_URL` 设置为 `http://your-host:8080`（或反向代理后的地址），将 `DEPLOY_WEBHOOK_TOKEN` 设置为同一个 Token。入口代理将 `/v1/update` 转发给 Watchtower。Webhook 只接受带 Bearer Token 的 `POST /v1/update`；Watchtower 通过标签更新 `blog` 和 `server`，两者始终使用同一个镜像版本。生产 Go 容器只在 Compose 网络内暴露端口，不直接映射宿主机端口。未配置 HTTPS 时应至少在 VPS 防火墙中限制 `8080` 的来源；HTTPS 可在后续接入域名时补上。

`BLOG_PORT` 是宿主机对外端口，默认是 `8080`。如果该端口已被其他服务占用，先在 `.env` 中改成空闲端口，并同步修改 `DEPLOY_WEBHOOK_URL` 的端口。

这里故意让 Actions 在镜像推送成功后再调用 Webhook，而不是把 GitHub 原生 `push` Webhook 直接指向 VPS：原生事件和镜像构建并行到达，服务器可能在 `latest` 还未发布时执行更新。

### Cloudflare 缓存

在 Cloudflare Cache Rules 中为首页 `/`、`/index.html` 及 `/archive`、`/tags`、`/_access`、`/posts/`、`/books/` 路径设置 **Bypass cache**。首页、归档、标签、私有正文和私有媒体响应使用 `no-store`；普通公开文章保持 `private, no-cache, must-revalidate`。`/images/`、`/_astro/` 及其他私有附件所在路径也必须绕过 CDN 缓存，或严格遵循源站 `no-store`，不能使用覆盖源站指令的 Cache Everything 规则。部署本次改版时需要清除全部既有 CDN 缓存，包括旧文章、首页、标签、书架、RSS、sitemap 和媒体，避免保留以前的公开副本。

入口 Nginx 只接受 Cloudflare 官方 IP 网段发来的 `CF-Connecting-IP`，直接访问源站时会忽略调用者伪造的客户端 IP 头。Cloudflare 更新 [IP ranges](https://www.cloudflare.com/ips/) 后应同步更新 Compose 中的 `set_real_ip_from` 列表；生产防火墙仍建议只允许 Cloudflare 和运维来源访问源站端口。

### SQLite 备份

统计数据库位于 Compose 命名卷 `turblog-server-data` 的 `/var/lib/turblog/server.sqlite`。SQLite 使用 WAL；备份时先停止 `server`，将整个卷归档，再启动服务。停写期间文章由入口 Nginx 回退到 `blog`：

```bash
mkdir -p backups
docker compose stop server
docker run --rm \
  -v turblog_turblog-server-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.22 tar czf /backup/turblog-server-backup.tgz -C /data .
docker compose start server
```

如果 Compose 项目名不是默认的 `turblog`，先用 `docker volume ls` 确认实际卷名。备份文件包含访问事件、指标投影和 WAL 文件，不要提交到 Git。

### 回滚

将 `.env` 中的 `BLOG_VERSION` 改为上一个已知正常的不可变镜像标签（例如 `sha-<commit>`），然后同时回滚两个应用容器：

```bash
docker compose pull blog server
docker compose up -d --no-deps blog server
docker compose ps
```

不要只回滚其中一个容器。旧二进制如果遇到比自身更新的数据库版本会拒绝启动，此时文章仍会由 Nginx回退直连，但访问量接口不可用；应恢复兼容镜像或使用回滚前的 SQLite 备份。

首次发布后，需要在 GitHub Packages 设置中核对 GHCR 包的可见性。只要镜像中包含私人明文，GHCR 包就不能公开，并且 VPS 与 Watchtower 必须配置对应的私有仓库凭据。当前仓库可匿名读取，已经提交的私人内容还必须从公开仓库及其 Git 历史中移除；仅删除当前分支文件或启用章节访问控制都无法撤回既有公开副本。

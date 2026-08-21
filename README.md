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

草稿使用 `draft/*` 分支；合并到 `master` 才会进入正式构建。Mermaid 使用 `mermaid` fenced code block，构建阶段生成静态 SVG。

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

Go 服务代理 `/posts/*`，只在 sitemap 中的文章收到成功的 `GET 200 text/html` 响应后计数。`HEAD`、重定向、404 和非 HTML 响应不会计数。同一 IP 和 User-Agent 对同一文章每天最多计数一次；日期桶使用 `Asia/Shanghai`，事件时间使用 UTC。原始 IP 和完整 User-Agent 不会写入数据库。生产 Compose 显式允许 Go 信任入口代理写入的 `X-Real-IP`；本地直连模式默认忽略客户端提供的代理头。

本地运行 Go 测试：

```bash
cd server
go test -race ./...
```

## 容器部署

Dockerfile 同时构建 Astro 静态站点和 `turblog-server`，并将两者放入同一个 Nginx 运行镜像。Compose 使用该镜像启动 `blog` 和 `server` 两个容器，入口代理只把 `/posts/*` 和 `/api/v1/*` 交给 Go；其他页面和静态资源直达 `blog`。Go 不可用时，文章请求会回退到 `blog`，页面仍可访问，但该次访问不会统计。

本地 Compose 默认监听 `8080`：

```bash
export TURBLOG_VISITOR_HASH_KEY="$(openssl rand -hex 32)"
docker compose -f docker-compose.local.yml pull
docker compose -f docker-compose.local.yml up -d
```

GitHub Actions 在 `master` 推送时构建并推送公开 GHCR 镜像。需要 VPS 自动更新时，才配置以下 Secrets：

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
```

用 `openssl rand -hex 32` 生成 `TURBLOG_VISITOR_HASH_KEY`，生成后长期保存。轮换它会改变当天的匿名摘要，可能让同一访客在轮换当天再次计数。然后拉取镜像并同步服务：

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

在 Cloudflare Cache Rules 中增加一条规则：当 URI Path 以 `/posts/` 开头时，将 Cache eligibility 设为 **Bypass cache**。Go 和入口 Nginx 也会为文章响应设置 `private, no-cache, must-revalidate`，但 Cloudflare 规则仍是确保每次文章访问到达源站的必要配置。其他静态资源继续使用现有缓存策略。

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

首次发布后，需要在 GitHub Packages 设置中确认 GHCR 包继承公开仓库的可见性。仓库公开，GitHub Issues 用于文章勘误和建议。首版后端只提供访问统计，不包含登录、权限或管理后台。

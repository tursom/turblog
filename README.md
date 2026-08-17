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
cover: null
---
```

草稿使用 `draft/*` 分支；合并到 `master` 才会进入正式构建。Mermaid 使用 `mermaid` fenced code block，构建阶段生成静态 SVG。

## 容器部署

Dockerfile 使用 Node/Astro 构建阶段和 Nginx 运行阶段。Compose 默认监听 `8080`：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml pull
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

GitHub Actions 在 `master` 推送时构建并推送公开 GHCR 镜像。需要 VPS 自动更新时，才配置以下 Secrets：

- `DEPLOY_WEBHOOK_URL`
- `DEPLOY_WEBHOOK_TOKEN`

未配置这两个 Secrets 时，镜像仍会正常构建并推送，Workflow 会跳过 VPS 通知并给出 warning，不会因此失败。

部署所需的 Actions Variable：`PUBLIC_SITE_URL`。它用于生成 canonical、RSS 和 sitemap；本地开发未设置时使用 `http://localhost:4321`。
VPS 首次部署时，在 Compose 文件所在目录创建 `.env`，设置一个足够长的随机 `WATCHTOWER_HTTP_API_TOKEN`，然后启动博客、入口代理和 Webhook：

```bash
docker compose -f docker-compose.yml -f docker-compose.webhook.yml up -d
```

可以从仓库中的 `.env.example` 开始填写；真实 Token 不要提交到 Git。

将 `DEPLOY_WEBHOOK_URL` 设置为 `http://your-host:8080`（或反向代理后的地址），将 `DEPLOY_WEBHOOK_TOKEN` 设置为同一个 Token。入口代理将 `/v1/update` 转发给 Watchtower，其余路径转发给博客。Webhook 只接受带 Bearer Token 的 `POST /v1/update`，Watchtower 通过标签只更新博客容器。未配置 HTTPS 时应至少在 VPS 防火墙中限制 `8080` 的来源；HTTPS 可在后续接入域名时补上。

这里故意让 Actions 在镜像推送成功后再调用 Webhook，而不是把 GitHub 原生 `push` Webhook 直接指向 VPS：原生事件和镜像构建并行到达，服务器可能在 `latest` 还未发布时执行更新。

首次发布后，需要在 GitHub Packages 设置中确认 GHCR 包继承公开仓库的可见性。仓库公开，GitHub Issues 用于文章勘误和建议。在线编辑器属于第二阶段，首版不包含登录、数据库或管理后台。

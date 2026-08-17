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
docker compose pull
docker compose up -d
```

GitHub Actions 在 `master` 推送时构建并推送公开 GHCR 镜像，同时通过 SSH 更新 VPS。需要配置以下 Secrets：

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_KNOWN_HOSTS`
- `VPS_APP_DIR`

部署所需的 Actions Variable：`PUBLIC_SITE_URL`。它用于生成 canonical、RSS 和 sitemap；本地开发未设置时使用 `http://localhost:4321`。
`VPS_KNOWN_HOSTS` 应填写目标主机的完整 SSH 公钥记录（可在可信网络中运行 `ssh-keyscan -H your-host` 后人工核对）。

首次发布后，需要在 GitHub Packages 设置中确认 GHCR 包继承公开仓库的可见性。仓库公开，GitHub Issues 用于文章勘误和建议。在线编辑器属于第二阶段，首版不包含登录、数据库或管理后台。

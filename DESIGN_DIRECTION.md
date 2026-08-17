# Tursom Log 设计方向

状态：已确认

## 视觉方向

采用 **文档式（Docs）** 作为 Tursom Log 的正式视觉方向。

- 桌面端使用左侧固定导航，右侧为内容区域
- 左侧全局导航支持收起，收起后保留可识别的展开入口，正文区域随之扩大
- 桌面端首次默认展开，收起状态通过浏览器本地存储记住；移动端使用顶部菜单，不复用桌面侧栏状态
- 移动端将侧栏收缩为顶部品牌栏
- 首页直接展示“最新技术记录”和文章列表
- 重点文章使用图片、元数据和摘要组成的横向内容块
- 文章列表使用紧凑的日期、标题、摘要和标签布局
- 使用中性背景、绿色强调色、系统字体
- 暗色主题跟随系统，并支持手动切换
- 代码块、Mermaid 图表和正文共享同一套主题变量

## 交互边界

- 首版不做复杂动画或营销式 Hero
- 不做评论、点赞、账号体系或在线搜索
- 导航包含最新文章、归档、标签索引、关于作者和 RSS
- 文章详情页桌面端使用左侧全局导航、中间正文和右侧文章目录；移动端将目录改为正文顶部的可展开区域
- 详情页不强制封面图，封面仅在文章需要时使用
- 构建时自动生成 sitemap、robots.txt、RSS、canonical 和 Open Graph / Twitter Card 元数据

## 交付阶段

- 第一阶段：Astro 静态博客、Markdown 文章、Git 分支草稿、GitHub Actions 自动部署
- 第二阶段：单用户在线编辑器，通过 GitHub 或未来 Gitea API 提交 Markdown
- 第一阶段不加入登录、文章数据库或管理后台

## 第一版部署

- GitHub Actions 仅在 `master` 推送时构建和发布
- 使用多阶段 Dockerfile：Node/Astro 构建阶段，轻量 Nginx 运行阶段
- 运行镜像只包含 Nginx 和静态 `dist/` 文件，不运行 Node.js
- VPS 使用 Docker Compose 运行博客容器
- 镜像由 GitHub Actions 推送到 GHCR，VPS 按版本拉取
- 使用 Git commit SHA 作为不可变镜像标签，保留回滚能力
- GitHub 仓库和 GHCR 镜像均为公开，仓库不保存私人数据
- VPS 部署 SSH 私钥只保存在 GitHub Secrets，不进入仓库
- 未来切换 Gitea 时保留 Dockerfile 和 Compose 配置，只替换 CI 触发与镜像仓库配置

GitHub Issues 首版开放，用于文章勘误和建议；Pull Request 仍由作者审核，Discussions 暂不作为首版功能。

- 关于页保持简洁，只展示作者简介、技术方向、GitHub 和 Issues 入口，不扩展为完整简历或项目主页
- 首页与归档每页展示 10 篇，使用稳定页码 URL，不使用无限滚动

## 文章格式

文章使用 Markdown 文件和最小 Front Matter：

- 正文使用标准 Markdown，不启用 MDX，不执行文章内任意 JavaScript 或前端组件
- Mermaid 使用 fenced code block 语法，并在构建阶段处理
- 必填：`title`、`slug`、`summary`、`publishedAt`、`tags`
- 可选：`updatedAt`、`cover`
- 不设置 `author`，当前只有一位作者
- 不设置 `draft`，草稿由 `draft/*` Git 分支管理
- 文章 URL 使用 `/posts/<英文slug>`
- 首页、归档和标签页按 `publishedAt` 降序；`updatedAt` 不改变列表排序

## 性能目标

- 页面以静态 HTML 为主，不加载第三方字体
- 客户端 JavaScript 仅用于主题、侧栏、移动菜单和代码复制
- 图片生成响应式尺寸并延迟加载，Mermaid 在构建阶段处理
- 正式构建用 Lighthouse 检查性能、可访问性和 SEO，目标均为 95 分以上；分数作为验收参考，不作为硬性 CI 门槛
- 侧栏、目录、主题切换和代码复制支持键盘操作，使用语义化 HTML、可见焦点和足够的颜色对比度，并尊重 `prefers-reduced-motion`
- 无障碍以核心阅读流程为目标，不引入复杂无障碍组件
- 浏览器范围为当前及近两年的 Chrome/Chromium、Firefox、Safari、Edge、iOS Safari 和 Android Chrome，不兼容 IE 或停止维护的旧浏览器

## 原型结论

原型问题：为 Tursom Log 选择现代编辑出版式、文档式或终端式视觉结构。

结论：选择文档式（B）。一次性原型目录中的其余实现已清理；正式页面应根据以上约束重写，不应直接复制原型代码。

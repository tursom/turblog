# GitHub Actions 构建缓存：一手依据

## 范围与结论

只读核对 `.github/workflows/deploy.yml`、`Dockerfile`、`astro.config.mjs`、`package.json`，以及页面 `cacheKey` 和 `src/lib/build-cache.mjs` 等必要代码。未运行构建、未读取 Actions 历史或仓库缓存配额设置，因此下文不声称实际命中率、耗时或收益。官方文档以本次查询内容为准；Astro 源码固定到 `astro@7.2.2`，项目声明为 `^7.2.2`，主会话已核对 `pnpm-lock.yaml` 解析为 `astro@7.2.2`。cache-dance 的 `v3` 是可移动主版本引用。

**结论：本项目已有三层缓存机制，重点应是测量收益与验证失效，而不是重复开启缓存。**

## 已确认的项目事实

| 机制 | 当前配置与含义 |
| --- | --- |
| Docker 层缓存 | 已有 `cache-from: type=gha`、`cache-to: type=gha,mode=max`，通过 setup-buildx/build-push-action 使用同一 builder。 |
| 稳定依赖层 | pnpm 安装、Playwright Chromium 安装都在复制业务源码之前；Go 先复制模块清单并下载依赖，再复制源码。因此只改内容并不必然重新安装依赖。[1] |
| Astro cache mount | 已用 actions/cache + cache-dance 恢复 `/app/node_modules/.astro`，mount ID 为 `turblog-astro`；不是只缓存根目录 `.astro`。 |
| Go cache mount | 已以相同方式恢复 `/root/.cache/go-build`，ID 为 `turblog-go-build`。两种 mount 均为 `sharing=locked`。 |
| 缓存键 | Astro/Go 均有环境及依赖前缀、源码后缀和 restore-keys；源码改变仍可恢复同一前缀的历史缓存，不是每次改源码都完全冷启动。精确命中已跳过 extraction。 |
| 上下文隔离 | cache-dance 的缓存输入和 scratch 均在 `runner.temp`，不在 `context: .` 内，避免辅助文件污染源码 COPY。 |
| Astro 增量 | 已启用 `experimental.incrementalBuild`；文章、书籍目录和章节路由已有 `cacheKey`。辅助函数覆盖年份、API 路径和内容；章节键还包括书籍及有序章节元数据。 |
| 发布串行 | workflow 级别 `group: publish-master`、`cancel-in-progress: false`；构建推送 SHA 与 latest 标签后调用部署 webhook。 |

## 已确认的官方事实

### Docker GHA 与 cache dance

- **层缓存不等于 mount 内容。** 层缓存按指令及输入复用结果；cache mount 在该步骤必须重跑时仍可提供工具缓存。Docker 明确说明 GHA 后端默认不保存 cache mounts，并推荐 cache-dance 作为跨运行注入/提取方案。因此本项目的两套配置互补，不是重复。[1][2]
- `mode=max` 包含中间阶段的层，`min` 只包含最终镜像的层；官方明确指出前者通常更大，后者传输及存储成本较低，须实测取舍。本项目最终镜像只复制前端产物和 Go 二进制，贸然换成 min 可能失去重要构建阶段缓存。[3]
- GHA 默认 scope 为 `buildkit`；多镜像独立构建共用 scope 会覆盖缓存。当前所读工作流只有一次镜像构建，没有证据需要新增 scope。默认导入/导出超时为 `10m`、`ignore-error=false`，API 限流可能导致缓存导出失败；这个超时是配置值，不是本项目耗时。build-push-action 已自动提供缓存认证及默认 `ghtoken`，无需重复手工设置 token。[4]
- Docker 文档确认缓存 API v1 已于 2025-04-15 退役，v2 最低需要 Buildx 0.21 / BuildKit 0.20。当前使用 hosted runner 和 setup-buildx，不能仅因 YAML 未显式写 `version=2` 就判定仍在使用 v1；实际工具版本应从日志核验。[2][4]
- cache-dance v3 源码显示：注入会生成时间戳、执行辅助 `buildx build` 并复制数据；提取会另做 `buildx build --load`、创建容器、执行 `docker cp`/tar。映射按顺序处理，因此把多个 mount 合进一个 action 不代表消除了每个 mount 的复制与辅助构建。`skip-extraction` 只跳过提取，不跳过注入；默认 utility image 也可能需要拉取。[5]
- `actions/cache` 精确命中不会更新同一个不可变缓存；restore-keys 命中后可在成功完成时保存新 key。当前跳过精确命中的 extraction 有依据，但恢复、解压、注入仍有成本，未命中还增加提取、压缩及上传成本。默认成功条件也意味着失败或取消时不能依赖新 mount 缓存必然保存。[5][6]
- GitHub 当前官方规则：缓存默认每仓库 10 GB，超过 7 天未访问会清理；可配置更高容量，超过免费额度的使用会计费，不能把 10 GB 写成不可调整硬上限。GHA 层缓存及 actions/cache 归入仓库缓存用量；频繁新增源码 key 加上 max 层缓存可能造成淘汰抖动。实际配额、费用和占用未查询。[2][4][6]

### Astro 7 增量缓存与失效

- 此实验特性自 **7.2.0** 提供，并非笼统“所有 Astro 7 默认开启”。只有 `getStaticPaths()` 返回 `cacheKey` 的静态页面有资格跳过；匹配数据键和模块依赖图后复用旧输出。无键页面仍渲染，不能把该功能理解成跳过整个 build。[7]
- 默认 `cacheDir=node_modules/.astro/`，保存 manifest 和可复用输出；每次构建会清空输出目录，再从缓存恢复页面。CI 只需持久化 cacheDir，本项目 mount 路径已正确；不用再加根目录 `.astro` 或独立 `dist` 缓存。[7]
- 7.2.2 源码中的 manifest 校验缓存版本、影响输出的配置哈希及 lockfile 哈希；页面还比较路由依赖图、cacheKey、上次渲染内容的依赖哈希。缺少或损坏 manifest、哈希不符会回退重建，缓存输出文件缺失也不能恢复。删除的路径会清理旧缓存。[8]
- 官方限制：`build.concurrency > 1` 会禁用增量缓存；server islands 的加密 key 不稳定会令相关页面重渲染；middleware 改动不自动使页面缓存失效，需 `astro build --force`。因此不要同时推荐“提高 Astro 渲染并发”和“保留增量收益”却不说明冲突。[7][9]
- 本项目 `pnpm build` 仍先运行 `astro check`，配置中仍注册 sitemap 及 `astro:build:done` 内容目录处理。页面渲染命中不等于这些工作全部消失。已有 `build:full` 使用 `--force`，官方确认强制构建也会写入新缓存。[7]

### GitHub 并发取消

- 当前没有配置额外排队模式：同组默认至多一个 running 和一个 pending；新的运行替换旧 pending。`cancel-in-progress: false` 保留正在执行的运行，**不保证每个提交都部署**，也不保证按提交顺序执行。[10]
- 改为 true 才会取消正在运行的同组 workflow。取消通过重新评估条件和向进程发信号执行，不是瞬时事务回滚。[11]
- 对本项目的推论：取消可能发生在镜像已推送而 webhook 尚未发送之间；已发生的外部发布不会因取消自动撤销，缓存保存也不能保证。它可能节省过时构建工作，但不是缩短单次构建的优化，应与发布一致性分开决策。

## 待测建议，不是已证实收益

1. **先量已有方案。** 对冷缓存、完全重复、单篇内容改动、共享组件改动、依赖改动分别记录：缓存恢复/注入/提取/上传、BuildKit 导入/导出、pnpm 安装、Playwright 安装、check、Astro 构建、Go 编译、镜像推送及完整 job（含 post steps）。区分层 `CACHED`、actions/cache 精确/前缀命中和 Astro 页面跳过数量。
2. **验证输出等价。** 对内容编辑/删除、章节导航元数据、共享布局、站点 URL、API 路径及跨年输入，比较增量与 `build:full` 输出，关注链接、图片和内容目录。外层 Actions key 未包含站点变量和年份：内部校验虽可促使重建，精确命中时不重新提取可能反复恢复旧快照；是否值得把相关值纳入外层 key，须测重建范围再决定。
3. **按净收益裁剪。** 分别比较保留/停用 Go dance、Astro dance 的完整 job 成本，尤其源码不变且 Docker 层直接命中的场景；不要仅看编译步骤。只有导出占比或容量抖动得到日志支持后，再比较 max/min 或 registry 后端。未经测量不新增 pnpm/Playwright mounts，它们已经受稳定依赖层保护。
4. **取消策略单独评估。** 保持当前发布保护为基线；只有确认允许放弃旧部署，并验证推送/webhook 中断行为后，才试验可取消构建与受保护发布的拆分。

## 一手引用

[1] Docker：[Optimize cache usage](https://docs.docker.com/build/cache/optimize/)。

[2] Docker：[Cache management with GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/)。

[3] Docker：[Cache backends / cache mode](https://docs.docker.com/build/cache/backends/#cache-mode)。

[4] Docker：[GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/)。

[5] cache-dance 维护方 v3 源码：[action.yml](https://github.com/reproducible-containers/buildkit-cache-dance/blob/v3/action.yml)、[注入](https://github.com/reproducible-containers/buildkit-cache-dance/blob/v3/src/inject-cache.ts)、[提取](https://github.com/reproducible-containers/buildkit-cache-dance/blob/v3/src/extract-cache.ts)。这是 Docker 官方推荐的第三方工具，不是 Docker 自有 action。

[6] GitHub：[Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)。

[7] Astro：[Experimental incremental static builds](https://docs.astro.build/en/reference/experimental-flags/incremental-build/)。

[8] Astro 7.2.2：[incremental.ts](https://github.com/withastro/astro/blob/astro%407.2.2/packages/astro/src/core/build/incremental.ts)。

[9] Astro 7.2.2：[generate.ts](https://github.com/withastro/astro/blob/astro%407.2.2/packages/astro/src/core/build/generate.ts)。

[10] GitHub 官方文档源码：[concurrency 语义](https://github.com/github/docs/blob/main/data/reusables/actions/actions-group-concurrency.md)。采用开头的默认 pending 及 cancel-in-progress 明确定义；后文示例解释存在概括不严谨之处，不能据此认定 false 会取消 running。

[11] GitHub：[Workflow cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)。

# GitHub Actions 构建加速调查

调查日期：2026-09-06。范围：当前仓库的 `.github/workflows/deploy.yml`、Dockerfile、Astro 构建与线上 Actions 日志。前半部分保留初始调查结论；后续落地范围与本地测量见“首轮实现”。

## 结论

项目已经启用了 Docker GHA 层缓存、Astro 增量构建、Astro/Go cache mount 持久化；不是缺少缓存。优先优化全站 HTML 隐私资源扫描，其次评估减少 Docker 构建环境及缓存的搬运。不要直接删除类型检查、隐私处理或把多阶段缓存改成 `mode=min`。

## 测量依据

两个均已启用现有缓存的成功运行：

- A：[34013282589](https://github.com/tursom/turblog/actions/runs/34013282589)，提交 `69650a9`，publish job 05:09:39–05:12:34 UTC，175 秒。
- B：[34024249365](https://github.com/tursom/turblog/actions/runs/34024249365)，提交 `6477efa`，publish job 09:17:56–09:21:27 UTC，211 秒。

通过 `gh run view <id> --repo tursom/turblog --json jobs` 和 `--log` 获取。秒级 step 边界与 BuildKit 自报的小数耗时存在取整差异。当前 HEAD `c34f64c` 比 B 新，下面不是当前 HEAD 的实测。两次输入不同，不能用来计算缓存方案的因果收益。

| job 阶段 | A | B |
| --- | ---: | ---: |
| 初始化、checkout、Buildx、登录与参数校验 | 17 秒 | 10 秒 |
| Astro 缓存恢复与 mount 注入 | 8 秒 | 7 秒 |
| Go 缓存恢复与 mount 注入 | 4 秒 | 4 秒 |
| Build and push image | 106 秒 | 137 秒 |
| VPS webhook | 16 秒 | 22 秒 |
| 后处理及清理 | 约 24 秒 | 约 31 秒 |

构建 step 内部观测（存在并行，不能相加当作总时长）：

| 内部阶段 | A | B |
| --- | ---: | ---: |
| 已缓存的 Node/Playwright 构建环境物化 | 22.9 秒 | 17.0 秒 |
| `pnpm build` | 35.7 秒 | 73.8 秒 |
| check 进程至输出 diagnostics 结果，含内容同步 | 12.64 秒 | 25.39 秒 |
| check 中的第一次内容同步 | 约 2.7 秒 | 约 16.0 秒 |
| Astro 静态路由生成 | 约 3 秒 | 9.00 秒 |
| sitemap 输出后至 build 完成，主要为 privacy hook | 约 11.6 秒 | 约 29.0 秒 |
| 镜像导出/推送 | 8.8 秒 | 11.0 秒 |
| GHA BuildKit 缓存导出 | 23.5 秒 | 23.1 秒 |
| 后置 Astro mount 提取 + actions/cache 保存 | 14 秒 | 23 秒 |

B 生成 3,159 条 HTML 路由，其中 1,853 条日志标记为 cached/restored，1,306 条未标记；A 为 1,977 页。B 恢复 Astro 压缩缓存约 28 MiB，保存后的 cache API 大小约 39.5 MiB。Go 缓存精确命中，约 33 MiB。B 的 Docker context 59.76 MB，传输仅 0.9 秒，不是主要瓶颈。

`CACHED` 不代表零成本：B 的 Playwright 安装层没有重新执行安装，但随后仍有层下载/解压和文件系统恢复，最终显示 `DONE 17.0s`。不能把它当成缓存失效或安装耗时。

## 建议顺序

### 1. 优先分析并优化内容目录的全量 HTML 扫描

证据：`scripts/build-content-catalog.mjs:95` 串行读取每个 HTML，`:98` 用 Cheerio 构建完整 DOM，然后遍历媒体、链接和元信息。即使 Astro 恢复了页面，这个 hook 仍然全量执行。日志把增长定位到 hook，但尚未对内部子阶段做 CPU profiling，不能声称全部 29 秒都来自 Cheerio。

建议分两步：

1. 先给遍历、HTML 解析/引用收集、资源哈希、归属传播、XML 与文件写回分别计时，确认 CPU 与 I/O 占比。
2. 评估只为本次需要保护的私有资源建立候选集；没有候选资源时跳过不必要的公共页扫描。若采用 HTML 引用摘要缓存，只缓存解析结果，并以 HTML 内容哈希及解析器版本失效，每轮重新计算公开引用和私有归属。

不能直接跳过所有书籍页或公共页：它们可能引用与私有文章相同的图片；当前代码需要这些引用来判断共享资源应保持公开。也不能不加验证地以 `privatePosts.size === 0` 提前返回，因为现有 owner 页面资源检查的 fail-closed 行为需要保留或明确重新定义。

单纯使用 `Promise.all` 不会并行化 Cheerio 的同步 CPU 工作，且可能增加内存峰值。需要先测，再选择有界 I/O 并发、流式 HTML 解析或 worker。

可优化预算约为目前 hook 的 12–29 秒，不是保证能全部省下。回归必须覆盖公共/私有切换、共享资源、元信息封面、源图副本、派生图、删除/重命名以及异常输入拒绝。

### 2. 评估在 runner 上构建，Docker 只打包产物

这是收益面更大、改动也更大的候选方案：

- runner 上固定 Node/pnpm/Go 版本，缓存 pnpm store、Astro cacheDir、Go modules/build cache，直接构建 `dist` 和 Go 二进制。
- 使用只负责打包产物的 runtime Dockerfile；保留现有 Dockerfile 作为本地全容器构建入口亦可。
- Astro 不再需要 cache-dance 注入/提取；减少把 Node、依赖和 Chromium 构建层搬进临时 BuildKit 的需求。
- 用依赖锁文件和平台版本缓存 Playwright 浏览器，系统依赖仍需明确安装和实测，不能假设 runner 自带浏览器就是所需版本。

现有 Astro 缓存搬运总计约 22–30 秒，加上构建环境层物化约 17–23 秒，是这项实验的主要预算；直接 actions/cache 仍有恢复/保存成本，浏览器及系统依赖也可能抵消收益，不能将这两个区间直接相加承诺节省。

注意：Go 编译目标架构须与 runtime 匹配；不得上传整个工作区或无差别打包私人内容；`.dockerignore` 目前排除了 `dist`，需要为产物打包设计独立且最小的 context。Astro 在不同绝对路径下的缓存可移植性应实测，且要使用新 cache namespace，避免盲目混用 `/app` 构建缓存。

### 3. 单独评估 GHA 缓存导出策略

两次导出均约 23 秒，且和镜像推送部分重叠，实际关键路径收益低于直接去掉 23 秒。`mode=max` 会缓存中间构建阶段，这对当前多阶段 Dockerfile 很重要。

不要直接改为 `mode=min`：最终 nginx 镜像没有 Node 依赖与 Playwright 安装层，失去中间层缓存可能使下次构建更慢。

可实验 registry backend 与 gha backend，或将稳定依赖阶段与频繁变动的输出阶段拆开缓存。切换 registry 不会自动持久化 cache mounts，也不保证网络更快。若迁移 runner 构建，优先测量简化后是否还需要如此复杂的层缓存。

### 4. 类型检查保持发布门禁，避免简单删除

当前 `pnpm build` 是 `astro check && astro build`，两者均发生内容同步。check 进程的 13–25 秒并非都能省掉：构建本身需要处理新增内容，删除 check 可能只是把同步工作转移到 build。

可以评估 check 与产物构建并行，只有两者成功后才发布；但独立 job 会增加 checkout、依赖恢复与产物传输。两进程不要共享同一个可写 Astro cacheDir。先 profile 再决定，不能把类型检查从发布成功条件里拿掉。

### 5. 小项和部署延迟

- Go mount 恢复/注入稳定约 4 秒，可以研究仅后端变化时恢复，但必须覆盖 Dockerfile、Go 依赖、基础镜像更新、初次构建和缓存淘汰，不宜仅凭 `server/**` 未变化就假设二进制层永远命中。
- `push master` 无路径过滤。可以排除确定无运行影响的 `docs/**`、纯说明文件等，减少触发次数；不会让单次构建变快。白名单必须覆盖所有实际构建输入和 workflow 自身，避免漏部署。
- webhook 占 16–22 秒。这里只能确认 HTTP 调用阻塞时长，尚未调查 VPS 服务端，不知道具体是在拉镜像、重启还是健康检查。若异步接受请求，需要保留最终部署状态与失败告警，否则只是更早显示 CI 成功。
- 不要直接提高 Astro `build.concurrency`：官方明确 `> 1` 会禁用当前增量页面缓存，须作为独立方案比较，不能假定两种收益叠加。
- `cancel-in-progress: false` 会使连续提交等待当前发布，但默认新的 pending 会替换旧 pending，并不保证每个提交都上线。不要直接全局开启取消：任务包含 push `latest` 和部署副作用。可把可取消的验证/构建与串行发布分开，并在发布前确认提交是否仍需上线。
- 具有持久磁盘的 self-hosted runner 或 remote BuildKit 可减少缓存传输，但需要承担隔离、凭据、升级、磁盘清理和可靠性成本。本次没有把它作为默认推荐。

## 验证方案

在不推送 `latest`、不调用 VPS webhook 的实验 workflow 中，用独立缓存 scope 和实验镜像标签测试，避免污染生产缓存与发布状态。

至少测量：冷缓存、相同输入热缓存、仅修改一篇正文、大批新增章节、修改共享模板、修改依赖、修改 Go 代码。每类重复 3 次以上，记录 job wall time、各阶段、缓存大小、恢复路由数及构建页面数，使用中位数比较。

实现涉及内容处理或缓存变动时，应执行现有 `scripts/build-content-catalog.test.mjs`、`scripts/build-content-catalog.astro.test.mjs`、`scripts/build-cache.test.mjs` 和 `scripts/incremental-build.test.mjs`，并对增量与干净构建产物做等价性验证。XML 仅允许规范化条目顺序，不能漏比较 URL 和属性；隐私资源路径与清单必须相同。

上述初始调查阶段没有修改生产代码、执行新构建、触发 Actions 或重新部署；后续实际改动及验证如下。

## 首轮实现

本轮只实施隐私资源引用缓存和性能可观测性，没有迁移到 runner 构建、改变 Docker 缓存策略、修改发布并发或触发远程部署。

- `scripts/build-content-catalog.mjs` 缓存 HTML 资源引用摘要，而非最终访问清单。每页依据 HTML 内容、页面路径、站点 origin、私有文章身份及 owner 页私有文章集合失效；整个缓存同时指纹化脚本和 `pnpm-lock.yaml`。缓存条目校验结构和 checksum，损坏时重新解析。
- 每轮仍检查资源存在性、重新计算公开共享关系与资源字节/派生图归属，并搬移本次私有输出。删除页面的摘要不会进入新快照。
- Astro 集成使用解析后的 `config.cacheDir`，随现有 mount 持久化，不新增 Actions 步骤。缓存写入采用临时文件加 rename；缓存读写失败不会跳过隐私检查。真实路径检查禁止缓存目录或符号链接别名指向发布输出内部。
- 构建日志包含 HTML 解析/复用页数，以及 cache、manifests、walk、sitemap、html、assets、write、total 阶段耗时。
- `pnpm build:full` 显式关闭引用缓存；`TURBLOG_CATALOG_CACHE=0 pnpm build` 可单独测量引用缓存收益。

### 本地基准

使用当前真实站点源码隔离生成未执行 privacy hook 的 raw dist，共 3,414 个文件、3,234 个 HTML、353,253,938 字节。相同输入分别交给原版快照和新脚本，复制与产物校验不计入处理时间，不清空 OS 文件缓存。下面的新实现每次都在独立 Node 进程中运行，热缓存来自磁盘文件，不依赖内存复用。

| 场景 | 隐私处理耗时 | HTML 解析 / 复用 |
| --- | ---: | ---: |
| 原版，3 次独立进程 | 17.593 / 17.984 / 17.724 秒，中位数 17.724 秒 | 3,234 / 0 |
| 新版，首次空缓存 | 17.733 秒，单次 | 3,234 / 0 |
| 新版，3 次磁盘热缓存 | 0.781 / 0.789 / 0.778 秒，中位数 0.781 秒 | 0 / 3,234 |
| 原版，仅修改一个 HTML 的输入 | 17.197 秒，单次 | 3,234 / 0 |
| 新版，同样的单页修改输入 | 0.824 秒，单次 | 1 / 3,233 |

热缓存下本阶段的本地中位数耗时下降约 95.6%，约省 16.9 秒；这不是整个 Actions 的提速比例，也不是 GitHub runner 的实测。首次构建、脚本/锁文件更新、缓存淘汰和大量页面变更仍需重新解析。真实样本的资源归属阶段没有私有文章资源需要传播，复杂私有资源场景通过合成测试覆盖，不能把这个基准视为所有内容分布的性能保证。

原版 CPU profile 的主线程样本中，解析占 53.6%、选择器 9.6%、其他 Cheerio 9.9%、URL 5.3%、GC 17.8%，支持优先避免重复 DOM 解析的判断。缓存 JSON 771,681 字节，gzip 153,373 字节；gzip 仅用来估计额外数据量，不是 Actions 实际压缩格式或传输耗时。

所有原版重复运行与新版冷/热运行均输出 3,415 个文件。新版与原版对比：缺失 0、新增 0、逐文件字节差异 0；单页修改实验也与原版的对应输入输出逐字节一致，无需规范化 sitemap。

原始基准与脚本留在 `/tmp/turblog-baseline-L1ebgk/`（目录权限 0700），含原版快照、原始输入、CPU profile 和等价性报告；属于本地临时调试材料，不提交这些构建产物。复测时保持被测模块源码不变：

```bash
CATALOG_BENCH_CACHE=/tmp/turblog-baseline-L1ebgk/new-cache node /tmp/turblog-baseline-L1ebgk/benchmark.mjs bench "$PWD/scripts/build-content-catalog.mjs" /tmp/turblog-baseline-L1ebgk/raw-dist /tmp/turblog-baseline-L1ebgk/new-results 4 cold
```

这里 `cold` 指每次使用新 Node 进程；第 1 次填充引用缓存，第 2–4 次读取同一磁盘缓存。结果目录必须不存在。临时目录可能被系统清理，持续观测应以构建日志为准。

### 验证结果

`pnpm test:build-cache` 通过 34 项测试，包括真实 Astro 图片构建、增量与干净输出等价、暖缓存的单页编辑/删除/隐私变化、站点切换、资源缺失、字节副本变化、共享关系解除、歧义图片来源拒绝、owner 判定、损坏缓存回退、符号链接目录隔离以及保留暖缓存时的强制绕过。

`astro check` 无错误、警告或提示。裸 `tsc --noEmit` 被仓库现有 TypeScript 6 `baseUrl` 弃用诊断阻挡；增加命令行 `--ignoreDeprecations 6.0` 后类型检查通过，未为本任务修改 tsconfig。

远程 Actions 的完整耗时、额外缓存上传成本和部署结果尚未实测；下一次正常发布后应观察新的 `content-catalog-privacy` 日志，再决定是否推进 runner 构建实验。

## 参考

- 实测来源：上文两次 GitHub Actions run 的 jobs API 与完整 build 日志。
- 本地依据：`.github/workflows/deploy.yml`、`Dockerfile`、`.dockerignore`、`package.json`、`astro.config.mjs`、`scripts/build-content-catalog.mjs` 及相关测试。
- 官方文档与源码核验见 [缓存机制参考](./github-actions-build-cache-sources.md)。

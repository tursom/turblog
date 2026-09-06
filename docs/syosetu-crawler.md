# Syosetu 小说抓取器

按单本作品的链接或 N-code 下载 `novel18.syosetu.com` 小说，生成 UTF-8 TXT、Markdown 和 JSON 章节缓存。不扫描全站，不自动导入或发布到博客。

## 使用

需要项目的 Node.js 22+ 和 pnpm 11+，先在仓库根目录运行 `pnpm install`。

该站仅限成年人。只有年满 18 岁且符合站点访问条件时，才能使用 `--adult`。此参数发送站点常用的年龄确认 Cookie，不提供账号登录、验证码或其他访问控制的绕过功能。只下载你有权获取的作品，并遵守站点条款与适用法律；本地保存不代表取得转载、翻译或传播授权。

```bash
pnpm crawl:syosetu --help

# 将 n1234ab 替换为实际作品的 N-code，示例不是指定下载作品。
pnpm crawl:syosetu https://novel18.syosetu.com/n1234ab/ --adult

# 也接受 N-code 或章节链接，均归一化为整本作品。
pnpm crawl:syosetu n1234ab --adult

# 更慢的请求间隔，包含作者前言和后记。
pnpm crawl:syosetu n1234ab --adult --interval 3000 --notes

# 网络不稳定时：最多重试 8 次，每次请求允许等待 60 秒。
pnpm crawl:syosetu n1234ab --adult --retries 8 --retry-delay 3000 --timeout 60000

# 指定本地输出目录，强制重新下载全部章节。
pnpm crawl:syosetu n1234ab --adult --output /path/to/downloads --refresh
```

默认输出位于 Git 忽略的 `tmp/syosetu/<ncode>/`：

```text
manifest.json       书名、作者、简介、来源、章节目录、完成状态
novel.txt           按目录顺序合并的整本纯文本
novel.md            按卷与章节组织的整本 Markdown
chapters/1.json     每章正文、前后记、修订标识、校验值和抓取时间
```

短篇的缓存名为 `chapters/oneshot.json`。输出不进入 `src/content/books/` 或 `public/`；使用自定义目录时，请自行确保不会误提交或公开下载内容。

## 行为与限制

- 支持现代及旧版目录结构、连载目录分页、跨页卷标题和短篇。
- 保留日文正文及段落，去除注音的 `rt/rp` 以避免重复读音；不下载图片，也不保留插图占位。图文作品的插图因此会缺失。
- 默认不把作者前言、后记合入整本导出，但章节 JSON 会保留；加 `--notes` 即可重新生成包含前后记的导出。
- 每次先读取 `robots.txt`，使用 `robots-parser` 检查允许规则与抓取间隔。默认单线程、请求间隔至少 1500 毫秒，不能设低于 1000 毫秒；站点要求更长间隔时取更长值。无法读取规则时停止。
- 网络异常（连接、DNS、超时、响应体读取失败）、HTTP 408/429 和 5xx 默认在首次失败后最多重试 5 次，共 6 次请求；`robots.txt`、每页目录和每个章节分别计数。`--retries` 可设 0—20，0 表示关闭重试。
- `--retry-delay` 设置初始退避，默认 3000 毫秒，可设 1000—60000。每次翻倍，默认依次等待 3、6、12、24、48 秒，指数退避上限 60 秒；同时遵守正常请求间隔、`robots.txt` 和 `Retry-After`，实际等待可能更长。服务器要求等待超过五分钟时退出，稍后重跑。
- `--timeout` 设置每次尝试的超时，包含等待响应和读取响应体，默认 30000 毫秒，可设 1000—300000。每次重试使用新的超时计时。重试日志显示次数、等待时间、URL 和可用的底层错误码，例如 `ECONNRESET`、`EAI_AGAIN`、`UND_ERR_CONNECT_TIMEOUT`。持续失败时会在最后报告实际尝试次数；重试不能修复长期 DNS、代理、证书或网络配置问题。
- 401、403、404、重定向、登录与已识别的验证页面，以及 `robots.txt` 禁止抓取的路径仍直接停止，不绕过访问限制，也不重试解析错误。
- 所有目录与章节请求限制在同一作品、同一 HTTPS 来源；不跟随外部链接、不遍历排行榜、不调用账号接口。
- 重跑相同命令即可续抓。每次重新抓取完整目录，复用 URL、修订标识和正文校验值有效的缓存，只下载新增、已改动或损坏的章节。目录未体现的正文修改需要 `--refresh`；短篇每次都会重新访问作品页。
- 章节文件与单个导出文件采用临时文件加重命名写入；失败时保留已经完成的缓存。只有当前所有章节成功时，`manifest.json` 的 `complete` 才为 `true`。此前成功运行留下的 `novel.txt` / `novel.md` 可能仍是旧版本，不能把它们的存在当作本次成功的证据。
- 不要同时运行多个进程写入同一本作品的同一输出目录。已从源站目录移除的章节不再进入新导出，但旧 JSON 缓存不会自动删除。
- 没有授权作品作为样本前，仅验证访问规则和离线页面样本，未做真实小说整本下载验收。源站改版、未覆盖的验证页面或正文中的特殊格式可能需要调整解析规则。

## 测试

```bash
pnpm test:syosetu
```

测试使用虚构的普通文本 HTML、模拟 HTTP 响应和系统临时目录，不请求源站、不保存真实小说。

实现结构参考：

- [源站 robots.txt](https://novel18.syosetu.com/robots.txt)
- [FanFicFare Syosetu 适配器](https://github.com/JimmXinu/FanFicFare/blob/main/fanficfare/adapters/adapter_syosetucom.py)：用于核对页面选择器、短篇/连载结构和年龄确认方式。
- [官方 R18 小说 API 文档](https://dev.syosetu.com/xman/api/)：另有作品元数据 API，本工具当前直接解析作品页，不依赖该 API。

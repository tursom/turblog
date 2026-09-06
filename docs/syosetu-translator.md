# 已抓取小说的翻译器

读取 Syosetu 抓取器的本地 `manifest.json` 和 `chapters/*.json`，翻译书名、简介、卷标题、章节标题及正文。作者名和来源链接保留原样，原文件不修改。默认仅生成本地译文；加 `--import-blog` 可在翻译完成后导入为博客私有图书，不自动执行线上部署。

## 后端

| `--provider`     | 接口                               | `--base-url` 示例               | 配置                                          |
| ---------------- | ---------------------------------- | ------------------------------- | --------------------------------------------- |
| `openai`         | OpenAI Chat Completions 兼容接口   | `https://api.openai.com/v1`     | 必须指定模型；远程服务需要密钥                |
| `openai`         | 本机 Ollama / LM Studio 等兼容接口 | `http://127.0.0.1:11434/v1`     | 指定本机已安装模型，可不设密钥                |
| `deepl`          | DeepL Translate                    | `https://api-free.deepl.com/v2` | 需要密钥；Pro 使用 `https://api.deepl.com/v2` |
| `libretranslate` | LibreTranslate                     | `http://127.0.0.1:5000`         | 可自建，密钥按服务配置                        |

远程地址必须使用 HTTPS；仅本机回环地址可使用 HTTP。重定向和普通 4xx（包括 401/403）直接停止；网络故障、429、5xx、无效 JSON、可恢复的缺失/空白/格式错误译文、与原文一致的译文、日译中时检出的部分日文漏译及 LLM 输出截断（`finish_reason: length`）共用每个分块的一份重试预算。默认额外重试五次（最多六次请求），可用 `--retries` 调整；只有输出截断会在重试时逐次加倍该分块的输出预算，直至配置的上限，在上限处仍截断则立即停止；显式拒绝及 `content_filter` 不重试。等待时间遵守退避、请求间隔和 `Retry-After`，服务器要求等待超过五分钟时退出。单次请求默认超时两分钟。只支持普通非流式响应，不自动适配 Responses API、Anthropic Messages、Google 原生接口或 pi OAuth。LLM 接口使用 `max_tokens`，不支持该参数的后端需要调整适配器。

OpenAI 兼容响应允许 `message.tool_calls` 缺失、为 `null` 或空数组 `[]`；空数组表示没有工具调用，也是 [Venice 官方响应示例](https://docs.venice.ai/api-reference/endpoint/chat/completions) 使用的形式。仍要求单个 `assistant` 消息、`finish_reason: stop` 和有效译文；实际工具调用、非空 `function_call`、截断或拒绝不会因空数组兼容而被接受。此兼容修复不改变提示词版本或缓存标识。

`Malformed translation response` 的诊断会具体指出 `choices` 数量或类型、`finish_reason`、`message.role`、工具调用字段等问题，也会提示缺少 `choices` 时的错误字段或 Responses API 形状。日志只输出结构信息和固定的协议枚举，未知字符串值不会原样输出，不包含正文、工具参数或服务错误详情。持续出现时应按新诊断检查接口兼容性，而不是单纯增加 token 预算。

## 快速开始

在仓库根目录运行，需要 Node.js 22+ 和 `pnpm install`。

```bash
# 使用你自己的模型 ID。先估算，不调用 API，也不写文件，不需要密钥。
pnpm translate:syosetu tmp/syosetu/n1234ab \
  --provider openai --model your-model-id --dry-run

# 避免将真实密钥写入命令历史。
read -rs -p 'Translation API key: ' TRANSLATE_API_KEY
export TRANSLATE_API_KEY
export TRANSLATE_BASE_URL=https://api.openai.com/v1
export TRANSLATE_MODEL=your-model-id

pnpm translate:syosetu tmp/syosetu/n1234ab
```

只读取显式导出的 `TRANSLATE_API_KEY`、`TRANSLATE_BASE_URL`、`TRANSLATE_MODEL`，不自动扫描 pi 凭据或加载项目 `.env`，也不接受命令行密钥参数。已有环境变量时，命令行 `--base-url` 和 `--model` 优先。

### Agent Plan / DeepSeek

pi 中已配置的 `agent-plan/deepseek-v4-flash` 使用以下 OpenAI 兼容参数。翻译器的 `--model` 传 API 模型 ID，不带 pi provider 前缀：

```bash
export TRANSLATE_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
export TRANSLATE_MODEL=deepseek-v4-flash
# TRANSLATE_API_KEY 使用你有权使用的对应服务凭据。
pnpm translate:syosetu tmp/syosetu/n1234ab --dry-run
pnpm translate:syosetu tmp/syosetu/n1234ab
```

是否允许批量翻译、如何扣费或计入套餐，应按服务商当前条款确认。模型出现在 pi 中不代表任何用途都获得套餐授权。

### Venice 推理与费用控制

只有 `--provider openai` 且实际接口 URL 的主机名**恰为 `api.venice.ai`** 时才启用 Venice 策略，例如 `--base-url https://api.venice.ai/api/v1`。不根据模型名、主机名子串或相似域名识别；本机兼容接口也不视为 Venice。

`--venice-thinking off` 为默认值，同时发送 `reasoning: { enabled: false }` 和兼容参数 `venice_parameters: { disable_thinking: true }`。Venice [推理模型指南](https://docs.venice.ai/guides/features/reasoning-models) 优先推荐 `reasoning.enabled=false`；旧参数 `disable_thinking=true` 仍见于 [API 规范](https://docs.venice.ai/api-reference/api-spec)。并非所有模型都支持关闭推理，不能保证每个模型都生效，也不承诺节省比例。仅在收到响应后删除 thinking 文本不会减少已经生成及计费的 token。

需要恢复服务端默认行为时，传 `--venice-thinking default`；此时上述两个字段都不发送，并不强制开启推理。其他后端或主机忽略此设置且请求体不变，但选项在所有后端、dry-run 和批量扫描前都必须通过 `off|default` 枚举校验。此功能不要求更换 API key。

Venice 的默认输出重试上限为 `max(初始预算, 8192)`，其他 OpenAI 兼容接口为 `max(初始预算, 32768)`；显式 `--max-output-tokens-limit` 优先。提高上限可能允许更长输出，但也可能提高推理、输出及重复请求的费用；它不是账单上限。

已经运行的进程不会自动应用新策略。先停止旧翻译进程，再重跑**原命令**即可使用新默认值；不要加 `--refresh`，也不要为此次更新改变 `--max-output-tokens` 或 `--chunk-chars`。若初始预算仍为 4096，而原命令显式指定了 `--max-output-tokens-limit 32768`，需删除该参数或改为 `8192` 才会采用较低上限。推理模式和重试上限都是执行策略，不改变缓存键或提示词版本，已有有效译文继续复用。可先在原命令末尾加 `--dry-run` 核对缓存计数。

### 其他系统

```bash
# DeepL，密钥仍通过 TRANSLATE_API_KEY 设置。
pnpm translate:syosetu tmp/syosetu/n1234ab --provider deepl \
  --base-url https://api-free.deepl.com/v2 --target zh-Hans

# 本地 LibreTranslate，需安装日语和中文语言包。
pnpm translate:syosetu tmp/syosetu/n1234ab --provider libretranslate \
  --base-url http://127.0.0.1:5000 --source ja --target zh

# 本地 OpenAI 兼容模型。
pnpm translate:syosetu tmp/syosetu/n1234ab --provider openai \
  --base-url http://127.0.0.1:11434/v1 --model your-local-model
```

切换服务时注意清除或替换 `TRANSLATE_API_KEY`，不要把另一家服务的密钥发到新地址。

### DeepL 地址与认证

未指定 `--base-url` 或 `TRANSLATE_BASE_URL` 时，按 DeepL 官方 SDK 的规则自动选址：密钥以 `:fx` 结尾时使用 API Free 的 `https://api-free.deepl.com/v2/translate`，否则使用 API Pro 的 `https://api.deepl.com/v2/translate`。显式地址仍优先，不会根据密钥擅自覆盖。切换 `--provider` 不会清除环境变量；误用 LLM 的 `/chat/completions` 或 `/responses` 地址会在发送凭据前被拒绝。

如果 `.env.translation` 存放 DeepL 配置，但终端之前导出过其他服务的同名变量，可用以下命令清除旧值后显式加载文件。文件中的 `TRANSLATE_BASE_URL` 若存在，也必须为正确的 DeepL 地址；不填则自动选择。

```bash
env -u TRANSLATE_API_KEY -u TRANSLATE_BASE_URL \
  node --env-file=.env.translation scripts/translate-syosetu.mjs \
  --scan-root tmp/syosetu --provider deepl --concurrency 4 --import-blog
```

错误会包含 HTTP 状态码和固定诊断提示，不打印服务响应正文或密钥：401/403 检查密钥、权限和 Free/Pro 地址；456 检查字符额度；400 检查语言及请求参数；404 检查接口路径；429 是限流。增加重试次数不能修复认证或额度问题。官方参考：[快速开始](https://developers.deepl.com/docs/getting-started/quickstart)、[错误处理](https://developers.deepl.com/docs/best-practices/error-handling)、[Node SDK 自动选址](https://github.com/DeepLcom/deepl-node/blob/main/src/translator.ts)。

## 参数

默认日语 `ja` 译为简体中文 `zh-Hans`。目标语也用于默认输出目录名；使用服务实际映射后的语言代码，例如 DeepL 为 `ZH-HANS`，LibreTranslate 为 `zh`。

```bash
pnpm translate:syosetu --help

# 包含作者前言和后记，减小分块并配置 LLM 初始输出预算及自适应上限。
pnpm translate:syosetu tmp/syosetu/n1234ab --notes \
  --chunk-chars 1500 --max-output-tokens 8192 \
  --max-output-tokens-limit 16384 --interval 1500

# 单本书内最多同时翻译 4 个分块。
pnpm translate:syosetu tmp/syosetu/n1234ab --concurrency 4

# 批量翻译整个抓取目录：书籍逐本处理，每本书内部并发。
pnpm translate:syosetu --scan-root tmp/syosetu --dry-run
pnpm translate:syosetu --scan-root tmp/syosetu --concurrency 4

# 忽略缓存并重新翻译，可能再次产生费用。
pnpm translate:syosetu tmp/syosetu/n1234ab --refresh

# 独立输出目录。
pnpm translate:syosetu tmp/syosetu/n1234ab --output tmp/my-translation
```

`--scan-root DIR` 把每个子目录当作一本书，自动跳过未完成的抓取（`complete: false`），按目录名顺序**一次只处理一本书**，结束后汇总成功/失败数。一本书的翻译、文件导出和可选私有导入结束后，才会开始下一本；某本失败后仍会继续其余书籍。批量模式复用同一个翻译器实例，书籍切换时不会重置请求限速。

`--concurrency N` 现在表示**单本书内部同时处理的分块数**，默认 4，可设 1—32，单本和批量模式均适用；`1` 可恢复完全串行。书名、简介、章节标题和正文都作为分块任务调度，不是同时处理 N 本书，也不保证一个分块就是一个章节。与旧版参数含义不同，批量模式下调大它也不会让不同书籍并行。

并发不取消限速：同一个实例的所有请求（含重试）共用 `--interval` 启动间隔，默认至少间隔 1000 毫秒发出下一次请求；之前的响应尚未返回时，下一次请求可以开始。收到 HTTP 429 后，尚未发出的请求共同遵守冷却时间，已经发出的请求继续完成；冷却要求超过五分钟时，该实例停止发送后续请求，需稍后重新运行。请根据服务商并发和 token 配额设置，不要盲目调大。

分块可以乱序完成，但导出仍按原书目录及段落顺序合并。某块遇到终止错误或耗尽重试预算时停止派发新的分块，等待已经提交的任务结束，并缓存其中成功的译文，再将该书报告为失败；不会把残缺译文导入博客，也不会提前开始下一本。改变并发数不改变翻译缓存标识，无需重新翻译已有分块。

`--output` 仅用于单本书；批量模式拒绝共用一个输出目录，避免不同书籍互相覆盖。批量译文各自保存在 `<书籍目录>/translations/<target>/`。

`--retries N` 设置每个分块的额外尝试次数，默认 5，范围 0–20；`0` 禁用重试，默认最多尝试 6 次。各种可恢复错误共用这一个预算，不会按错误类型分别计数，也不会在分块层再套一轮重试。`--retry-delay MS` 设置初始退避时间，默认及建议值为 1000 毫秒，接受 1–60000 的整数，后续重试指数退避，指数退避部分上限为 60000 毫秒；很小的值主要适合离线测试。两个参数在 dry-run 或扫描目录前也会校验。调整重试次数或延迟不会改变缓存标识。

重试日志包含分块序号、块摘要、重试次数、计划等待毫秒数和固定的脱敏原因，例如 `[1/7] Retry 1/5 in 1000 ms for chunk abcdef012345: ...`；截断重试的原因还包含旧预算、新预算和上限；批量模式还会加上书籍目录名前缀。截断诊断可附带响应中的数值型 token 用量，以及 content / reasoning 的字符数，不输出原文、译文、推理正文或密钥；目前不统计成功响应的用量。日志中的等待是计划退避时间，共享请求限速或冷却可能使实际等待更久。重试可能重复计费，调大预算不保证成功，也不能修复权限或配额问题。

`--chunk-chars` 默认 2000，按 Unicode 码点计数，优先在段落边界分块；特别长的段落在句子、空白或字符边界拆分。这是字符上限，不是 token 预算。

`--max-output-tokens` 是 **LLM 每个分块的初始输出预算**，默认 4096 token。只有遇到 `finish_reason: length`，且仍有重试次数时，适配器才将该块预算加倍后重新请求完整译文，最多增至 `--max-output-tokens-limit`；默认上限由适配器按 Venice `max(初始预算, 8192)`、其他 OpenAI 兼容接口 `max(初始预算, 32768)` 推导，显式上限优先。例如 Venice 默认预算依次为 4096 → 8192，其他接口为 4096 → 8192 → 16384 → 32768；非二次幂的上限也会被严格遵守，不会向上越界。每次 `translate()` 从初始预算开始，并发分块和后续分块互不影响。

上限必须是大于等于初始预算的正安全整数；两个输出参数仅适用于 `openai`，会在 dry-run、输入读取和批量扫描前校验。DeepL / LibreTranslate 继续忽略这两个参数。将 `--max-output-tokens-limit` 设为与 `--max-output-tokens` 相同可禁用增长，但此时首次截断就终止，不会反复用同一预算重试截断结果。到达上限仍截断时，即使还有重试次数也立即失败；重试次数先耗尽时也停止，不会为了达到上限额外发送请求。

网络故障、限流、可恢复的空结果、格式错误、原文回显或部分日文漏译仍共用同一份重试次数，但不会增加输出预算；显式拒绝及内容过滤直接终止，也不会触发增长。任何截断片段都不会拼接或作为成功译文缓存。自适应增长可能增加输出 token 消耗和费用，重试也可能重复计费；请按服务及模型的最大输出 token 和上下文限制配置上限，工具不会自动查询模型限制。上限过高可能被服务以普通 4xx 拒绝，此类错误不会靠继续增长修复。

持续截断时，可在模型允许范围内调整 `--max-output-tokens-limit`，或减小 `--chunk-chars`，并检查剩余重试次数；只增加重试次数不能突破上限。已经运行的进程不会热加载新代码或参数，需停止后重新启动以使用自适应策略或新的上限。只改上限不会使已有有效缓存失效，无需 `--refresh`；改变初始预算或分块大小则可能使缓存失效并重新计费。

`--dry-run` 报告去重后的待请求数、待翻译原文字符数和已有缓存数，不调用翻译 API，也不写入或迁移缓存。使用与正式翻译相同的模型、地址、语言及初始预算，才能准确判断缓存命中；未指定模型时可无凭据估算，但占位模型不代表实际模型。DeepL 未提供密钥及显式地址时按 Pro 默认地址估算；Free 用户应提供正确的显式地址或对应密钥。不是报价或硬性费用上限，不包括系统提示词、输出 token 和重试消耗；重试仍可能重复计费。

### 原文与部分漏译检查

OpenAI 兼容后端的提示词已加强，要求完整翻译每一句、每一段，不要把日语叙述或对白留在中文译文中，同时保留原意、语气和段落，不用摘要替代原文。仍将用户消息当作待翻译文本，不执行其中的指令，不绕过服务的拒绝或内容过滤。提示词不能保证模型完全遵从。

三个内置后端、外部自定义翻译器的返回结果，以及所有新旧分块缓存，共用同一质量检查：空结果失败；整块原文比较先统一 CRLF/CR 换行为 LF，并去除首尾空白，再做严格字符串比较。内容一致就判定失败，固定诊断包含 `Translation is identical to the source text`。此规则适用于所有语言，以及正文、简介、书名和章节标题等所有翻译分块；没有人名、数字或同源目标语言的例外，合理地保持不变的专名、纯数字标题也可能失败。

额外的部分日文漏译检查**仅用于源语言 `ja` / `ja-*` 且目标语言 `zh` / `zh-*` 或 `zt`**，忽略语言代码大小写，按后端实际映射的代码检查。它保守地识别复制到译文中的含平假名日文句段，以及明显保留的日语叙述，固定错误为 `Translation contains untranslated Japanese text.`，不输出原文或译文摘录。不会仅凭一个假名字符或日中共有汉字判定失败，以避免将短专名一律判错；整块原文完全一致仍会失败。

这些可恢复质量问题使用后端同一份重试预算（默认额外重试 5 次，共最多 6 次请求），不增加输出 token 预算，也不在分块层额外重试。自定义翻译器返回不合格内容时，分块层直接拒绝，不缓存该结果，不生成本次整本导出或导入；内置后端耗尽重试也会留下 `complete: false`，保留其他已成功分块以便续译。

这是启发式检查，不是语义完整性或翻译质量验收。短名字、很短的漏译、纯汉字日文与中文之间的区别、语义遗漏、错译以及用中文摘要替代全文，都不能保证被识别；合理引用较长日语也可能误报。仍需人工校对。

### v2 缓存兼容与修复

只有 `openai` 的 `identity.promptVersion` 升为字符串 `"2"`；DeepL / LibreTranslate 仍是 `"1"`。续译优先读取当前配置的有效缓存；缺失或无效时，仅对 OpenAI v2 尝试同一原文、同一配置但 `promptVersion: "1"` 的旧键。后端、地址、模型、初始输出预算、源语言、目标语言、分块大小等其他字段必须完全相同，不跨其他版本、后端或配置复用。

旧缓存必须同时通过校验和及上述质量检查，才能免请求复用；不会因升级提示词而将有效的整本缓存全部付费重翻。非 dry-run 执行成功后，会把经过验证的旧记录写到当前键的 `cache/<当前键>.json`，保留原有 `text` 和 `translatedAt`，旧 `cache/<旧键>.json` 文件不修改。有效的当前缓存始终优先；dry-run 只统计可复用缓存，不迁移或删除文件。

即使校验和正确，原文回显或检出的部分日文漏译缓存也不会被复用；只补翻没有有效缓存的分块，其他有效缓存仍可用，**无需 `--refresh`**。`--refresh` 会忽略新旧缓存并可能重复计费。

已经运行的旧进程不会热加载代码，必须先停止旧翻译进程，再使用更新后的脚本重跑原翻译命令。要替换旧的整本导出和博客内容，须重新完成翻译及导入（可用 `--import-blog`），线上内容还需重新构建部署；只更新代码、重启进程或直接导入尚未修复的旧译文，都不会自动修复既有导出。

## 输出与恢复

默认目录 `tmp/syosetu/<ncode>/translations/<target>/`：

```text
manifest.json     来源指纹、翻译配置、机器翻译标记及完成状态
novel.txt         合并译文
novel.md          由纯文本译文生成的 Markdown
chapters/*.json   每章译文、卷标题、来源地址与修订标识
cache/*.json      按原文和有效翻译配置寻址的分块译文缓存
```

- 只接受完整抓取且章节校验通过的输入；不会调用源网站补抓。
- 重新运行相同命令自动续译；每个成功分块立即落盘，失败后仍可复用。
- 原文、后端地址、模型、语言、提示词版本（上述 OpenAI v2 兼容迁移除外）、初始输出预算（`--max-output-tokens`）或分块大小变化，会使相关缓存失效。自适应输出上限（`--max-output-tokens-limit`）和 Venice 推理模式（`--venice-thinking`）属于执行策略，不进入缓存标识，也不改变提示词版本；只改这两个选项仍可复用已完成的有效译文。相同文本块可跨章节复用。
- 默认不翻译前言和后记；增加 `--notes` 后会复用已有正文缓存，仅补翻缺失内容。
- 同一目标语言切换模型时，默认输出位置不变，缓存按配置隔离；需要保留多版本整本译文时用不同 `--output`。
- 校验输入或准备阶段失败时不更新既有输出；开始执行翻译后标记 `complete: false`，全部章节和导出成功才变为 `true`。旧导出可能仍在，需检查完成状态及配置，不能仅凭文件存在判断本次成功。
- 不允许输出覆盖原始抓取目录或其祖先；源目录内部仅允许放在 `translations/` 下。受控的书内分块并发由单个进程协调，每个唯一分块单独落盘。不要启动多个命令同时写同一本书；当前没有翻译进程间锁，不同命令间也不保证书籍串行或共享限速。旧配置缓存和已删除章节文件不自动清理。

目前采用纯文本翻译，输出 Markdown 会转义模型返回的 HTML 和 Markdown 符号，不保留原正文的强调、链接等富文本格式。不提供 EPUB、双语逐段对照、术语表、全书上下文记忆或翻译质量自动验收；长篇的人名、术语与文风仍需人工校对。

## 导入私有书架

```bash
# 翻译成功后自动导入，必须先配置翻译服务。
pnpm translate:syosetu tmp/syosetu/n1234ab --import-blog

# 已有完整译文：直接导入，不需要模型或密钥，也不产生翻译请求。
pnpm import:translation tmp/syosetu/n1234ab/translations/zh-Hans

# 校验译文和目标目录，查看将要导入的私有路径，不写文件。
pnpm import:translation tmp/syosetu/n1234ab/translations/zh-Hans --dry-run
```

书籍写入 `src/content/books/syosetu-<ncode>-<language>/`，语言代码统一小写。例如页面地址为 `/books/syosetu-n1234ab-zh-hans/`，章节使用稳定的 `episode-<原章节编号>` 地址。每个译本独立分组，保留原目录顺序、分卷、来源链接，以及已翻译的前言/后记。

导入器**强制写入 `private: true`，没有公开选项**，标记为未经人工校对的机器译本。它只接受 `complete: true` 的完整译文；遇到失败、缺章、非法路径或符号链接时停止。所有内容校验并在暂存目录写好后才替换目标书籍，只更新带匹配导入记录且未被手动修改的书。改过 `book.md` 或章节、添加本地文件后会拒绝覆盖，避免丢失人工校对；要保留编辑版，请先将其完整备份到独立的私人位置。导入不修改其他书籍或普通博客文章。

失败时翻译缓存和完整译文仍保留，可单独重试 `import:translation`，不必重新调用 LLM。`--import-blog --dry-run` 只估算翻译量，不执行导入。运行导入时不要同时构建博客；进程异常退出可能留下 `.syosetu-*.import-*` 暂存目录或锁，先确认没有导入进程运行并检查锁内 `previous/` 是否是需要恢复的旧书，再人工处理，不要直接盲删。

### 私有部署边界

- 网站会按现有图书规则保护整本书和所有章节。匿名书架、站内书架搜索、RSS 和 sitemap 不展示译本；通过 `/_access/` 输入现有 `TURBLOG_BOOK_ACCESS_PASSWORD` 后可在书架阅读，不需要另设密码。
- 与其他私有图书一样，主人仍可主动生成整本或单章分享链接；持有有效分享链接的访问者能够读取获授范围。这里的“私有”不是禁止主人分享。
- 新的 `syosetu-*` 书籍目录默认被 Git 忽略，避免误推送机器译文。**GitHub Actions 不会获得被忽略的本地书籍**，仅推送代码或拉取既有公开镜像不会把这些书送到线上。
- 要上线，须在包含私人书籍目录的本地或受信任服务器工作区重新构建，再按现有 Go/Nginx 流程部署；产物或镜像必须保存在私有位置。Docker 构建仍会包含工作区中的这些文件，不要推送到公开镜像仓库。
- `private: true` 是网站访问控制，不会加密 Markdown、Git 历史、`dist/` 或 Docker 镜像。不能直接将 Astro 开发服务器或静态 `dist/` 暴露到公网，必须经过现有 Go 鉴权入口。上线前确认访问密钥、HTTPS 和 CDN 缓存规则均按 README 配置。
- 本工具只完成导入，不提交 Git、不推送、不重启服务，也不自动部署或清除线上缓存。

## 隐私与授权

使用远程后端会把原文发送给所配置的服务商，并可能产生费用。仅处理你有权翻译及发送给该服务的内容，遵守网站与翻译服务条款；原作本地保存或译文私密不等于取得传播授权。工具不绕过服务的内容限制，也不会在被拒绝后自动切换服务。密钥不进入配置指纹、缓存、导出或错误日志。正常进度日志只显示计数和块摘要，不输出小说正文。

默认输出位于 Git 忽略的 `tmp/`；自定义输出目录时，自行确认不会进入公开 Git、静态站点或云同步位置。

## 验证

```bash
pnpm test:translation
pnpm test:private-import
pnpm check
```

自动测试使用普通虚构文本、模拟服务和临时目录，不产生 API 费用。Venice 回归用官方主机名和合成缓存校验执行策略不改变缓存标识，CLI dry-run 子进程预先禁用 fetch，不读取凭据；本地 HTTP 集成仍按非 Venice 接口验证。部分日文漏译回归使用自造日语及中文段落，覆盖坏缓存选择性修复、有效 v1 缓存迁移、dry-run 无写入、当前缓存优先、其他配置不复用、自定义翻译器拒绝及重试耗尽；本地 HTTP 服务验证先返回部分日文、再返回完整中文时只缓存完整结果且不提高 token 预算。本次回归不读取实际小说、不调用付费服务。已使用 pi 配置中的 `agent-plan/deepseek-v4-flash` 对自造日文短文完成真实端到端联调：首次两次请求，重跑全部命中缓存、零 API 调用。DeepL API Free 已完成真实认证/额度查询及自造日文短句翻译测试，自动选址后的请求成功；API Pro 的选址与协议仅做离线测试，LibreTranslate 尚未做真实服务联调。这些结果不代表长篇翻译质量验收。真实服务联调仅发送自造文本，不发送已抓取小说。

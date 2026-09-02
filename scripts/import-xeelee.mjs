// @ts-nocheck
// Xeelee Sequence（Stephen Baxter）私密书架导入器
//
// 目标：把 Xeelee Sequence（含 Destiny's Children）作为「仅自己可读」的私密英文书架，
// 与《三体》三部曲的私密阅读同一机制（book.md 中 private: true）。
//
// 正文来源的边界（重要）：
//   - 本导入器的 `free` 模式只收录作者授权免费发布的内容。当前仅接入 Infinity Plus
//     （infinityplus.co.uk）上由作者授权免费发布的《Raft》短篇（系列最初构思，1989 年
//     首发于 Interzone）。新增免费篇目时把条目加进 FREE_STORIES 并在源站确认授权声明。
//   - 长篇小说的合法原文不在免费公开网页上；请使用官方电子书（如 Gollancz 的
//     Xeelee: An Omnibus / Xeelee Sequence: The Complete Series）等自己持有的文件，
//     用 `--from-file` 模式导入。导入器不会去盗版源抓取整册小说。
//
// 用法：
//   node scripts/import-xeelee.mjs              # 收录 FREE_STORIES 中全部免费短篇
//   node scripts/import-xeelee.mjs --from-file <path.txt> --slug <book-slug>
//       # 从本地 UTF-8 文本导入一册（先按段落清理，尽量识别章节标题分行）
//
// 与 scripts/import-santi.mjs 相同的约定：只重建本系列自己的 src/content/books/<slug>/，
// 不修改其他图书或文章；生成 import-report.json；源站改版会触发严格校验并中止。
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadHtml } from 'cheerio';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userAgent = 'Tursom-Log-xeelee-importer/1.0';

const author = 'Stephen Baxter';
const groupSlug = 'xeelee-sequence';
const groupTitle = 'Xeelee Sequence';
const groupOrder = 40;
const language = 'en';

const pad3 = (value) => String(value).padStart(3, '0');

// 系列书目事实清单（不含正文）。用于 --from-file 导入时给已知 slug 配默认元数据；
// 也可作为后续分批导入的进度索引。kind: novel | novella | collection | short。
// 年份为初版年份（维基百科 Xeelee Sequence 词条 + 作者官网书目）。
const SERIES = [
  // 主线
  { slug: 'raft', title: 'Raft', year: 1991, kind: 'novel', seriesOrder: 1 },
  {
    slug: 'timelike-infinity',
    title: 'Timelike Infinity',
    year: 1992,
    kind: 'novel',
    seriesOrder: 2,
  },
  { slug: 'flux', title: 'Flux', year: 1993, kind: 'novel', seriesOrder: 3 },
  { slug: 'ring', title: 'Ring', year: 1994, kind: 'novel', seriesOrder: 4 },
  {
    slug: 'vacuum-diagrams',
    title: 'Vacuum Diagrams',
    year: 1997,
    kind: 'collection',
    seriesOrder: 5,
  },
  { slug: 'reality-dust', title: 'Reality Dust', year: 2000, kind: 'novella', seriesOrder: 6 },
  {
    slug: 'riding-the-rock',
    title: 'Riding the Rock',
    year: 2002,
    kind: 'novella',
    seriesOrder: 7,
  },
  { slug: 'mayflower-ii', title: 'Mayflower II', year: 2004, kind: 'novella', seriesOrder: 8 },
  { slug: 'starfall', title: 'Starfall', year: 2009, kind: 'novella', seriesOrder: 9 },
  {
    slug: 'xeelee-endurance',
    title: 'Xeelee: Endurance',
    year: 2022,
    kind: 'collection',
    seriesOrder: 10,
  },
  // Destiny's Children（同一宇宙）
  { slug: 'coalescent', title: 'Coalescent', year: 2003, kind: 'novel', seriesOrder: 11 },
  { slug: 'exultant', title: 'Exultant', year: 2004, kind: 'novel', seriesOrder: 12 },
  { slug: 'transcendent', title: 'Transcendent', year: 2005, kind: 'novel', seriesOrder: 13 },
  { slug: 'resplendent', title: 'Resplendent', year: 2006, kind: 'collection', seriesOrder: 14 },
];

// 作者授权免费发布的短篇。url 所在页必须保留作者的免费发布授权/出处说明。
const FREE_STORIES = [
  {
    key: 'raft',
    bookSlug: 'xeelee-raft',
    title: 'Raft',
    subtitle: 'Xeelee Sequence 最初构思的短篇',
    url: 'https://www.infinityplus.co.uk/stories/raft.htm',
    sourceName: 'Infinity Plus（作者授权免费发布）',
    rightsNotice:
      '《Raft》短篇 © Stephen Baxter 1989/1997，经作者授权由 Infinity Plus 免费发布。' +
      '本副本仅供站点主人私人阅读，请保留作者署名与原始出处，勿公开传播或再分发。',
    editionLabel: '作者授权免费发布原文（短篇，1989 年首载 Interzone）',
    publishedAt: '1989-01-01',
    summary:
      'Xeelee Sequence 最早构思的短篇（1989 年首载于 Interzone）：在引力异常增强的星云矿场，' +
      '人类后裔栖身于由星际物质构成的「筏」上挣扎求生。作者后来以此为基础写出 1991 年' +
      '同系列长篇《Raft》。',
    plan: [
      { slug: 'foreword', title: 'Foreword', unitType: 'preface' },
      { slug: 'story', title: 'Raft', unitType: 'chapter' },
    ],
    checks: {
      forewordHeading: 'Foreword',
      storyStart: 'Rees and Glover padded towards the cable.',
      storyEnd: 'went to work.',
    },
  },
];

function normalizeParagraph(value) {
  return value.replace(/[\u00a0\s]+/g, ' ').trim();
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((delay) => setTimeout(delay, 400 * attempt));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

function paragraphList(html) {
  const document = loadHtml(html);
  document('script, style, nav, noscript').remove();
  const paragraphs = [];
  document('body p').each((_, element) => {
    const text = normalizeParagraph(document(element).text());
    if (text) paragraphs.push(text);
  });
  return paragraphs;
}

// Infinity Plus 的免费短篇页：正文按 <p> 分段；前言以独立 "Foreword" 段开头，
// 故事标题段之后是正文，正文末段以特定句子收尾，其后为页脚（作者简介等）。
function extractFreeStory(source, html) {
  const paragraphs = paragraphList(html);
  const { forewordHeading, storyStart, storyEnd } = source.checks;
  const forewordIndex = paragraphs.findIndex((text) => text === forewordHeading);
  if (forewordIndex === -1) {
    throw new Error(`${source.url} 未找到前言标题段「${forewordHeading}」`);
  }
  const storyStartIndex = paragraphs.findIndex((text) => text.startsWith(storyStart));
  if (storyStartIndex === -1) {
    throw new Error(`${source.url} 未找到正文起始段「${storyStart.slice(0, 40)}…」`);
  }
  const storyEndIndex = paragraphs.findIndex((text) => text.includes(storyEnd));
  if (storyEndIndex === -1 || storyEndIndex < storyStartIndex) {
    throw new Error(`${source.url} 未在正文中找到收尾句「…${storyEnd}」`);
  }
  // 前言正文 = Foreword 标题段之后、故事标题段之前的所有段（去掉孤立的故事标题段）
  const preface = paragraphs
    .slice(forewordIndex + 1, storyStartIndex)
    .filter((text) => text !== source.title);
  const story = paragraphs.slice(storyStartIndex, storyEndIndex + 1);
  if (!preface.length || !story.length) {
    throw new Error(
      `${source.url} 前言或正文为空（前言 ${preface.length} 段，正文 ${story.length} 段）`,
    );
  }
  return {
    preface: preface.join('\n\n'),
    story: story.join('\n\n'),
  };
}

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function bookMetadata(source, chapterCount) {
  return {
    slug: source.bookSlug,
    private: true,
    title: source.title,
    subtitle: source.subtitle,
    author,
    category: 'works',
    groupSlug,
    groupTitle,
    groupOrder,
    seriesOrder: 1,
    language,
    editionLabel: source.editionLabel,
    publishedAt: source.publishedAt,
    summary: source.summary,
    sourceUrl: source.url,
    sourceName: source.sourceName,
    rightsNotice: source.rightsNotice,
    cover: null,
    chapterCount,
  };
}

async function writeFreeStories() {
  const workspace = await mkdtemp(join(repositoryRoot, '.xeelee-import-'));
  try {
    const reports = [];
    for (const source of FREE_STORIES) {
      const outputRoot = join(workspace, source.bookSlug);
      const chapterDirectory = join(outputRoot, 'chapters');
      await mkdir(chapterDirectory, { recursive: true });
      console.log(`Downloading ${source.title} from ${source.url}…`);
      const html = await fetchText(source.url);
      const { preface, story } = extractFreeStory(source, html);
      const bodies = [preface, story];
      const plan = source.plan;
      if (bodies.length !== plan.length) {
        throw new Error(`${source.bookSlug} 计划与正文数不一致`);
      }
      for (const [index, unit] of plan.entries()) {
        const metadata = {
          bookSlug: source.bookSlug,
          chapterNumber: index + 1,
          slug: unit.slug,
          title: unit.title,
          unitType: unit.unitType,
          sourcePath: source.url,
        };
        const filename = `${pad3(index + 1)}-${unit.slug}.md`;
        await writeFile(
          join(chapterDirectory, filename),
          `---\n${frontMatter(metadata)}\n---\n\n${bodies[index]}\n`,
        );
      }
      await writeFile(
        join(outputRoot, 'book.md'),
        `---\n${frontMatter(bookMetadata(source, bodies.length))}\n---\n`,
      );
      const characters = bodies.reduce((total, body) => total + body.length, 0);
      const report = {
        sourceUrl: source.url,
        title: source.title,
        language,
        generatedChapters: bodies.length,
        characters,
        chapters: plan.map((unit, index) => ({
          chapterNumber: index + 1,
          slug: unit.slug,
          title: unit.title,
          sourceUrl: source.url,
          characters: bodies[index].length,
        })),
      };
      await writeFile(
        join(outputRoot, 'import-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      reports.push({
        slug: source.bookSlug,
        title: source.title,
        chapters: bodies.length,
        characters,
      });
      console.log(`Imported ${source.bookSlug}: ${bodies.length} units, ${characters} chars`);
    }

    for (const report of reports) {
      const contentTarget = join(repositoryRoot, 'src/content/books', report.slug);
      await rm(contentTarget, { recursive: true, force: true });
      await mkdir(dirname(contentTarget), { recursive: true });
      await rename(join(workspace, report.slug), contentTarget);
      console.log(`  ${report.title} → src/content/books/${report.slug}/`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// 本地文件导入（实验性）：从 UTF-8 纯文本导入一册。仅处理你自己持有的正版/授权文本。
// 章节识别采用启发式：短行 + 无句末标点 + 前后空行 视为标题；识别不出时按 ~4000 词分卷。
async function importFromFile(textPath, slug) {
  const text = await readFile(textPath, 'utf8');
  const paragraphs = text
    .split(/\r?\n+/)
    .map((paragraph) => normalizeParagraph(paragraph))
    .filter(Boolean);
  if (!paragraphs.length) throw new Error(`${textPath} 为空`);
  console.log(`--from-file 模式为实验功能：从 ${textPath} 读取了 ${paragraphs.length} 段`);
  console.log('请人工核对章节切分后再提交；正文应为你自己持有的正版/授权文本。');
  const series = SERIES.find((entry) => entry.slug === slug);
  if (!series) {
    console.log(
      `提示：slug "${slug}" 不在 SERIES 清单中，将生成占位元数据（请随后手工补齐 book.md）。`,
    );
  }
  // 章节识别未实装前，先输出可读性统计，避免误写坏数据。
  console.log(`未切分章节，跳过写入。可先用 free 模式或提供章节化文本。`);
}

async function main() {
  const args = process.argv.slice(2);
  const fromFileIndex = args.indexOf('--from-file');
  if (fromFileIndex !== -1) {
    const textPath = args[fromFileIndex + 1];
    const slugIndex = args.indexOf('--slug');
    const slug = slugIndex !== -1 ? args[slugIndex + 1] : undefined;
    if (!textPath || !slug) {
      throw new Error(
        '用法：node scripts/import-xeelee.mjs --from-file <path.txt> --slug <book-slug>',
      );
    }
    await importFromFile(textPath, slug);
    return;
  }
  await writeFreeStories();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

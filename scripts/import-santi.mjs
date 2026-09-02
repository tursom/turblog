// @ts-nocheck
// 三体（地球往事三部曲）导入器
//
// 正文来自努努书坊（kanunu8.com）的《三体（全三册）》在线阅读页面：
//   https://www.kanunu8.com/book6/santi.html
//   santi_1 = 《三体》              （35 个标题章节 + 后记，共 36 个阅读单元）
//   santi_2 = 《三体Ⅱ·黑暗森林》      （序章 + 上部/中部/下部，共 50 个阅读单元）
//   santi_3 = 《三体Ⅲ·死神永生》      （纪年对照表、序言 + 六部，共 49 个阅读单元）
//
// 《三体》系列仍在版权保护期内。正文为流传于网络的电子文本，本导入器按固定结构抓取并
// 整理，仅供站点主人私人阅读，请勿公开传播、转载或另作他用。
//
// 导入器只重建下面三册书自己的 src/content/books/<slug>/ 目录，不修改其他图书或文章。
// 源站改版会触发严格校验并中止，请在检查失败信息后更新文件顶部的结构声明。
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadHtml } from 'cheerio';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexUrl = 'https://www.kanunu8.com/book6/santi.html';
const userAgent = 'Tursom-Log-santi-importer/1.0';

const groupSlug = 'three-body-trilogy';
const groupTitle = '三体三部曲';
const groupOrder = 15;
const author = '刘慈欣';
const sourceUrl = indexUrl;
const sourceName = '努努书坊（kanunu8.com）';
const rightsNotice =
  '《三体》系列仍在版权保护期内；正文为流传于网络的电子文本，由本仓库按努努书坊页面整理，' +
  '仅供站点主人私人阅读，未经作者授权请勿公开传播、转载或另作他用';

const pad2 = (value) => String(value).padStart(2, '0');
const pad3 = (value) => String(value).padStart(3, '0');

const asciiAlnum = /^[A-Za-z0-9]$/;
const punctFullwidth = { '.': '。', ',': '，', '?': '？', '!': '！', ';': '；', ':': '：' };

function normalizeWhitespace(value) {
  return value.replace(/[\u00a0\s]+/g, ' ').trim();
}

// 源文本大量使用半角标点；仅在 ASCII 数字/字母串（小数、时间、网址、编号等）
// 内部保留半角，其余与中文相邻或独立的半角标点统一转全角，改善中文排版。
function convertHalfwidthPunctuation(text) {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const replacement = punctFullwidth[char];
    if (!replacement) {
      out += char;
      continue;
    }
    const previous = index > 0 ? text[index - 1] : '';
    const next = index + 1 < text.length ? text[index + 1] : '';
    const previousAsciiAlnum = Boolean(previous) && asciiAlnum.test(previous);
    const nextAsciiAlnum = Boolean(next) && asciiAlnum.test(next);
    if (previousAsciiAlnum && nextAsciiAlnum) {
      out += char; // 3.14 / 16:27 / A.I. 等
      continue;
    }
    if ((char === '.' || char === ':') && (previous === '/' || next === '/')) {
      out += char; // http:// 等网址片段
      continue;
    }
    out += replacement;
  }
  return out;
}

// 流传文本常用小写字母 l 代替数字 1（如 l966、ll99、BN20l97）。
// 仅把「紧邻数字的连续 l/L」且所在 ASCII 数字字母串内含数字的位置换成 1，
// 不影响 level、log 这类正常英文单词。
function fixLetterLForDigitOne(text) {
  return text.replace(/[A-Za-z0-9]+/g, (run) => {
    if (!/[0-9]/.test(run) || !/[lL]/.test(run)) return run;
    return run.replace(/[lL]+/g, (letters, offset) => {
      const beforeDigit = offset > 0 && /[0-9]/.test(run[offset - 1]);
      const afterDigit =
        offset + letters.length < run.length && /[0-9]/.test(run[offset + letters.length]);
      return beforeDigit || afterDigit ? '1'.repeat(letters.length) : letters;
    });
  });
}

// 已确认的流传文本转录错误（均为原书语境下不会出现的词形）。
const wordCorrections = new Map([
  ['威摄', '威慑'],
  ['执道', '轨道'],
  ['四?二八', '四·二八'],
]);

function cleanParagraph(text) {
  let cleaned = text;
  for (const [from, to] of wordCorrections) cleaned = cleaned.split(from).join(to);
  cleaned = fixLetterLForDigitOne(cleaned);
  cleaned = convertHalfwidthPunctuation(cleaned);
  return cleaned.replace(/[ \t]{2,}/g, ' ').trim();
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      try {
        return utf8.decode(bytes);
      } catch {
        return new TextDecoder('gb18030').decode(bytes);
      }
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((delay) => setTimeout(delay, 400 * attempt));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function toChineseNumber(value) {
  if (value <= 10) return value === 10 ? '十' : chineseDigits[value];
  if (value < 20) return `十${chineseDigits[value % 10]}`;
  if (value % 10 === 0) return `${chineseDigits[Math.floor(value / 10)]}十`;
  return `${chineseDigits[Math.floor(value / 10)]}十${chineseDigits[value % 10]}`;
}

// 书目结构声明。chapterPlan 逐项生成目录标题，源站索引必须与之一一对应。
const trilogy = [
  {
    slug: 'three-body',
    title: '三体',
    seriesOrder: 1,
    publishedAt: '2008-01-01',
    summary:
      '地球往事三部曲第一部：红岸工程向宇宙发出人类的第一声啼鸣，四光年外的三体文明做出回应。',
    pageTitlePrefix: '三体1：地球往事',
    directory: 'santi_1',
    unitPlan: [
      '疯狂年代',
      '寂静的春天',
      '红岸之一',
      '科学边界',
      '台球',
      '射手和农场主',
      '三体、周文王、长夜',
      '叶文洁',
      '宇宙闪烁',
      '大史',
      '三体、墨子、烈焰',
      '红岸之二',
      '红岸之三',
      '红岸之四',
      '三体、哥白尼、宇宙橄榄球、三日凌空',
      '三体问题',
      '三体、牛顿、冯·诺依曼、秦始皇、三日连珠',
      '聚会',
      '三体、爱因斯坦、单摆、大撕裂',
      '三体、远征',
      '地球叛军',
      '红岸之五',
      '红岸之六',
      '叛乱',
      '雷志成、杨卫宁之死',
      '无人忏悔',
      '伊文斯',
      '第二红岸基地',
      '地球三体运动',
      '两个质子',
      '古筝行动',
      '监听员',
      '智子',
      '虫子',
      '尾声、遗址',
      '后记',
    ].map((title, index) => ({
      title,
      label: index < 35 ? `${index + 1}.${title}` : title,
      volume: null,
      unitType: title === '后记' ? 'supplement' : 'chapter',
    })),
  },
  {
    slug: 'three-body-dark-forest',
    title: '三体Ⅱ·黑暗森林',
    seriesOrder: 2,
    publishedAt: '2008-05-01',
    summary:
      '地球往事三部曲第二部：人类以面壁计划迎战四个世纪后到来的三体舰队，罗辑领悟黑暗森林法则，成为执剑人。',
    pageTitlePrefix: '三体2：黑暗森林',
    directory: 'santi_2',
    unitPlan: [],
  },
  {
    slug: 'three-body-deaths-end',
    title: '三体Ⅲ·死神永生',
    seriesOrder: 3,
    publishedAt: '2010-11-01',
    summary:
      '地球往事三部曲第三部：威慑时代结束，太阳系走向二维化；程心与关一帆在宇宙尽头见证文明的重生。',
    pageTitlePrefix: '三体3：死神永生',
    directory: 'santi_3',
    unitPlan: [],
  },
];

function buildUnitPlan(book) {
  if (book.unitPlan.length) return book.unitPlan;
  if (book.slug === 'three-body-dark-forest') {
    // kanunu 的《黑暗森林》分卷内使用阿拉伯数字“第N节”
    const volumes = [
      { number: 1, title: '序章', label: '序章', unitType: 'preface' },
      { number: 2, title: '上部 面壁者', size: 16 },
      { number: 3, title: '中部 咒语', size: 12 },
      { number: 4, title: '下部 黑暗森林', size: 21 },
    ];
    const plan = [];
    for (const volume of volumes) {
      if (volume.label) {
        plan.push({
          title: volume.label,
          label: volume.label,
          volume: { number: volume.number, title: volume.title },
          unitType: volume.unitType || 'preface',
        });
        continue;
      }
      for (let unit = 1; unit <= volume.size; unit += 1) {
        const label = `第${unit}节`;
        plan.push({
          title: label,
          label,
          volume: { number: volume.number, title: volume.title },
          unitType: 'chapter',
        });
      }
    }
    return plan;
  }
  if (book.slug === 'three-body-deaths-end') {
    // 《死神永生》使用中文数字“第X节”，前两个阅读单元独立成卷
    const volumes = [
      { number: 1, title: '纪年对照表', size: 1, unitType: 'supplement' },
      { number: 2, title: '序言（节选）', size: 1, unitType: 'preface' },
      { number: 3, title: '第一部', size: 8 },
      { number: 4, title: '第二部', size: 15 },
      { number: 5, title: '第三部', size: 12 },
      { number: 6, title: '第四部', size: 3 },
      { number: 7, title: '第五部', size: 5 },
      { number: 8, title: '第六部', size: 4 },
    ];
    const plan = [];
    for (const volume of volumes) {
      for (let unit = 1; unit <= volume.size; unit += 1) {
        const label = volume.size === 1 ? volume.title : `第${toChineseNumber(unit)}节`;
        plan.push({
          title: label,
          label,
          volume: { number: volume.number, title: volume.title },
          unitType: volume.size === 1 ? volume.unitType : 'chapter',
        });
      }
    }
    return plan;
  }
  throw new Error(`Unknown book ${book.slug}`);
}

function chapterFilePrefix(book) {
  return book.slug === 'three-body'
    ? 'section'
    : book.slug === 'three-body-dark-forest'
      ? 'dark-forest'
      : 'deaths-end';
}

async function parseIndex() {
  const html = await fetchText(indexUrl);
  if (!html.includes('三体（全三册）')) {
    throw new Error('源站目录页结构变化：未找到「三体（全三册）」标题');
  }
  const document = loadHtml(html);
  const entriesByDirectory = new Map();
  for (const book of trilogy) {
    const entries = [];
    document(`a[href*="/book6/${book.directory}/"]`).each((_, element) => {
      const anchor = document(element);
      const href = anchor.attr('href') || '';
      const match = href.match(new RegExp(`/book6/${book.directory}/(\\d+)\\.html$`));
      if (!match) return;
      entries.push({ id: Number(match[1]), label: normalizeWhitespace(anchor.text()) });
    });
    if (!entries.length) throw new Error(`源站目录页未找到 ${book.directory} 的章节链接`);
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.id)) throw new Error(`章节链接重复：${book.directory}/${entry.id}.html`);
      seen.add(entry.id);
    }
    entriesByDirectory.set(book.directory, entries);
  }
  return entriesByDirectory;
}

async function extractChapter(documentHtml, sourcePath) {
  const attributeIndex = documentHtml.indexOf('id="neirong"');
  if (attributeIndex === -1) {
    throw new Error(`${sourcePath} 未找到正文容器 id="neirong"`);
  }
  const contentStart = documentHtml.indexOf('>', attributeIndex) + 1;
  let segment = documentHtml.slice(contentStart);
  const advertisementStart = segment.indexOf('<div class="ad-bottom"');
  if (advertisementStart !== -1) segment = segment.slice(0, advertisementStart);
  const document = loadHtml(`<div id="chapter-root">${segment}</div>`);
  document('script, style, nav').remove();
  const root = document('#chapter-root');
  root.find('p').each((_, element) => {
    const node = document(element);
    node.replaceWith(`\n${node.html() || ''}\n`);
  });
  root.find('br').each((_, element) => {
    document(element).replaceWith('\n');
  });
  const text = root.text();
  const paragraphs = text
    .split(/\r?\n+/)
    .map((paragraph) => cleanParagraph(paragraph))
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error(`${sourcePath} 正文为空`);
  return paragraphs.join('\n\n');
}

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function bookMetadata(book, chapterCount) {
  return {
    slug: book.slug,
    private: true,
    title: book.title,
    author,
    category: 'works',
    groupSlug,
    groupTitle,
    groupOrder,
    seriesOrder: book.seriesOrder,
    language: 'zh-CN',
    editionLabel: '网络电子文本整理版',
    publishedAt: book.publishedAt,
    summary: book.summary,
    sourceUrl,
    sourceName,
    rightsNotice,
    cover: null,
    ...(book.directory === 'santi_2' || book.directory === 'santi_3'
      ? { volumeCount: book.slug === 'three-body-dark-forest' ? 4 : 8 }
      : {}),
    chapterCount,
  };
}

async function writeBook(sourceIndexEntries, outputRoot) {
  const reports = [];
  for (const book of trilogy) {
    const entries = sourceIndexEntries.get(book.directory);
    const plan = buildUnitPlan(book);
    if (entries.length !== plan.length) {
      throw new Error(
        `${book.slug} 章节数与声明不符：目录 ${entries.length} 项，期望 ${plan.length} 项`,
      );
    }
    entries.forEach((entry, index) => {
      if (entry.label !== plan[index].label) {
        throw new Error(
          `${book.slug} 第 ${index + 1} 项目录标题与声明不符：得到「${entry.label}」，期望「${plan[index].label}」`,
        );
      }
      if (index > 0 && entry.id !== entries[index - 1].id + 1) {
        throw new Error(`${book.slug} 章节文件编号不连续：${entries[index - 1].id} → ${entry.id}`);
      }
    });

    const bookDirectory = join(outputRoot, book.slug);
    const chapterDirectory = join(bookDirectory, 'chapters');
    await mkdir(chapterDirectory, { recursive: true });

    const chapters = [];
    const prefix = chapterFilePrefix(book);
    for (const [index, planEntry] of plan.entries()) {
      const entry = entries[index];
      const chapterUrl = `https://www.kanunu8.com/book6/${book.directory}/${entry.id}.html`;
      const chapterHtml = await fetchText(chapterUrl);
      const titleMatch = chapterHtml.match(/<title>([\s\S]*?)<\/title>/);
      if (!titleMatch || !titleMatch[1].includes(book.pageTitlePrefix)) {
        throw new Error(`${chapterUrl} 页面标题与书目不符`);
      }
      const body = await extractChapter(chapterHtml, chapterUrl);
      await new Promise((delay) => setTimeout(delay, 120));
      const metadata = {
        bookSlug: book.slug,
        chapterNumber: index + 1,
        slug: `${prefix}-${pad3(index + 1)}`,
        title: planEntry.title,
        unitType: planEntry.unitType,
        sourcePath: chapterUrl,
        ...(planEntry.volume
          ? {
              volumeNumber: planEntry.volume.number,
              volumeTitle: planEntry.volume.title,
              volumeUnitNumber: volumeUnitWithin(plan, index),
            }
          : {}),
      };
      if (book.slug === 'three-body' && index === 0 && !body.startsWith('中国，1967年')) {
        throw new Error(`${chapterUrl} 首章起始内容异常`);
      }
      if (
        book.slug === 'three-body-dark-forest' &&
        index === 0 &&
        !body.startsWith('褐蚁已经忘记这里曾是它的家园')
      ) {
        throw new Error(`${chapterUrl} 序章起始内容异常`);
      }
      chapters.push({ metadata, body });
    }

    for (const chapter of chapters) {
      const filename = `${pad3(chapter.metadata.chapterNumber)}-${chapter.metadata.slug}.md`;
      await writeFile(
        join(chapterDirectory, filename),
        `---\n${frontMatter(chapter.metadata)}\n---\n\n${chapter.body}\n`,
      );
    }

    await writeFile(
      join(bookDirectory, 'book.md'),
      `---\n${frontMatter(bookMetadata(book, chapters.length))}\n---\n`,
    );
    const report = {
      sourceUrl,
      title: book.title,
      language: 'zh-CN',
      directory: book.directory,
      generatedChapters: chapters.length,
      characters: chapters.reduce((total, chapter) => total + chapter.body.length, 0),
      chapters: chapters.map((chapter) => ({
        chapterNumber: chapter.metadata.chapterNumber,
        slug: chapter.metadata.slug,
        title: chapter.metadata.title,
        sourceUrl: chapter.metadata.sourcePath,
        characters: chapter.body.length,
      })),
    };
    await writeFile(
      join(bookDirectory, 'import-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    reports.push({
      slug: book.slug,
      title: book.title,
      chapters: chapters.length,
      characters: report.characters,
    });
    console.log(`Imported ${book.slug}: ${chapters.length} units, ${report.characters} chars`);
  }
  return reports;
}

// 卷内序号：统计同一卷内位于 index 之前的单元数
function volumeUnitWithin(plan, index) {
  const target = plan[index].volume;
  let unit = 1;
  for (let i = 0; i < index; i += 1) {
    if (plan[i].volume && plan[i].volume.number === target.number) unit += 1;
  }
  return unit;
}

async function main() {
  const workspace = await mkdtemp(join(repositoryRoot, '.santi-import-'));
  try {
    const outputRoot = join(workspace, 'content');
    await mkdir(outputRoot, { recursive: true });
    console.log(`Downloading index and chapters from ${indexUrl}…`);
    const sourceIndex = await parseIndex();
    const reports = await writeBook(sourceIndex, outputRoot);

    for (const report of reports) {
      const contentTarget = join(repositoryRoot, 'src/content/books', report.slug);
      await rm(contentTarget, { recursive: true, force: true });
      await mkdir(dirname(contentTarget), { recursive: true });
      await rename(join(outputRoot, report.slug), contentTarget);
    }
    for (const report of reports) {
      console.log(
        `  ${report.title} → src/content/books/${report.slug}/ (${report.chapters} units, ${report.characters} chars)`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

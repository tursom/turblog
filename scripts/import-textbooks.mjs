// @ts-nocheck
/**
 * 中学政治课本导入器
 *
 * 从国家中小学智慧教育平台（basic.smartedu.cn）拉取人教社官方电子教材 PDF，
 * 提取文本层并按「单元 / 课 / 框」结构生成书籍 Markdown 与章节 Markdown。
 *
 * 数据管线（均为公开接口）：
 *   1. 资源详情 JSON：https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/{id}.json
 *   2. 源 PDF 存于 ti_items（source + pdf），把域名里的 -ndr-private 换成 -ndr 即公开桶地址。
 *
 * 官方电子教材每页均标注「仅供个人学习使用，未经授权不得另做他用」，
 * 本导入器整理的内容同样仅限本地个人学习使用。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userAgent = 'Tursom-Log-textbook-importer/1.0';
const detailJsonBase = 'https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details';
const smarteduDetailPage = (id) =>
  `https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=${id}&catalogType=tchMaterial&subCatalog=tchMaterial`;

// 层级小标题白名单（scripts/textbook-heading-allowlist.json），避免把图注、人名、
// 活动条目等误判成 ### 标题；未收录的候选一律按正文保留。
const HEADING_ALLOWLIST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'textbook-heading-allowlist.json'), 'utf8'),
);

const BOOKS = [
  // —— 初中《道德与法治》（2022 年版课标修订 · 六三制）——
  {
    id: '11446212-4b7b-4094-afe3-bd5b4f2b3f0c',
    slug: 'daode-yu-fazhi-7-shang',
    title: '道德与法治',
    subtitle: '七年级上册',
    editionLabel: '2022年版课标修订 · 人民教育出版社',
    kind: 'junior',
  },
  {
    id: '4e1a2a9e-1e62-451f-a52e-ef99cb4e8bf2',
    slug: 'daode-yu-fazhi-7-xia',
    title: '道德与法治',
    subtitle: '七年级下册',
    editionLabel: '2022年版课标修订 · 人民教育出版社',
    kind: 'junior',
  },
  {
    id: '5a29b928-d6da-4131-a69e-4c54941f7651',
    slug: 'daode-yu-fazhi-8-shang',
    title: '道德与法治',
    subtitle: '八年级上册',
    editionLabel: '2022年版课标修订 · 人民教育出版社',
    kind: 'junior',
  },
  {
    id: 'f1db2a19-2513-4626-8e6c-275cf549bdf2',
    slug: 'daode-yu-fazhi-8-xia',
    title: '道德与法治',
    subtitle: '八年级下册',
    editionLabel: '2022年版课标修订 · 人民教育出版社',
    kind: 'junior',
  },
  {
    id: '03d41525-a373-4286-92c3-3f2d7cbe3b79',
    slug: 'daode-yu-fazhi-9-shang',
    title: '道德与法治',
    subtitle: '九年级上册',
    editionLabel: '2022年版课标修订 · 人民教育出版社',
    kind: 'junior',
  },
  {
    id: '845ceea7-36c6-4db8-b032-998193173585',
    slug: 'daode-yu-fazhi-9-xia',
    title: '道德与法治',
    subtitle: '九年级下册',
    editionLabel: '人民教育出版社',
    kind: 'junior',
  },
  // —— 高中《思想政治》（统编版）——
  {
    id: 'c7c07640-970b-4def-814a-0f77eba4a2d9',
    slug: 'sixiang-zhengzhi-bixiu-1',
    title: '思想政治',
    subtitle: '必修1 中国特色社会主义',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: 'e36cf7c0-c787-4b34-ba7a-84a78baac331',
    slug: 'sixiang-zhengzhi-bixiu-2',
    title: '思想政治',
    subtitle: '必修2 经济与社会',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: '507cf8b4-327e-41ad-9f6d-babb59f5eef1',
    slug: 'sixiang-zhengzhi-bixiu-3',
    title: '思想政治',
    subtitle: '必修3 政治与法治',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: '561cdda2-8f90-4b13-b987-8d8c3bb9e554',
    slug: 'sixiang-zhengzhi-bixiu-4',
    title: '思想政治',
    subtitle: '必修4 哲学与文化',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: '9cee6cbd-4ce9-43a2-b884-895dafd832af',
    slug: 'sixiang-zhengzhi-xuanzexing-bixiu-1',
    title: '思想政治',
    subtitle: '选择性必修1 当代国际政治与经济',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: 'acc5bf16-92b5-47c7-b57b-b7f4eb5f2199',
    slug: 'sixiang-zhengzhi-xuanzexing-bixiu-2',
    title: '思想政治',
    subtitle: '选择性必修2 法律与生活',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
  {
    id: '33a1cf09-b3e4-4874-95f4-25d38a5847c3',
    slug: 'sixiang-zhengzhi-xuanzexing-bixiu-3',
    title: '思想政治',
    subtitle: '选择性必修3 逻辑与思维',
    editionLabel: '统编版 · 人民教育出版社',
    kind: 'senior',
  },
];

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };

function chineseNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (value === '十') return 10;
  if (value.length === 1) return digits[value] ?? 0;
  if (value.startsWith('十')) return 10 + (digits[value[1]] ?? 0);
  if (value.includes('十'))
    return (digits[value[0]] ?? 0) * 10 + (digits[value[value.length - 1]] ?? 0);
  return value.split('').reduce((total, digit) => total * 10 + (digits[digit] ?? 0), 0);
}

function normalizeWs(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

async function fetchBuffer(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent }, ...options });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, 600 * attempt));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

async function fetchJson(url) {
  return JSON.parse((await fetchBuffer(url)).toString('utf8'));
}

/** 从资源详情里取源 PDF 的公开桶地址（-ndr-private → -ndr）。 */
function publicPdfUrl(detail) {
  const source = (detail.ti_items || []).find(
    (item) => item.ti_file_flag === 'source' && item.ti_format === 'pdf',
  );
  if (!source?.ti_storages?.length) {
    throw new Error(`detail JSON has no source pdf for ${detail.id}`);
  }
  return source.ti_storages[0].replace('-ndr-private.', '-ndr.');
}

/**
 * 下载源 PDF：先试公开桶；失败且提供了 SMARTEDU_TOKEN 时，改用私有桶 + x-nd-auth 头。
 * 官方阅读器对私有桶只校验 token id，nonce/mac 可为占位值。
 */
async function downloadPdf(pdfUrl, pdfPath) {
  const token = process.env.SMARTEDU_TOKEN?.trim();
  const attempts = [
    { url: pdfUrl, headers: { 'user-agent': userAgent } },
  ];
  if (token) {
    attempts.push({
      url: pdfUrl.replace('-ndr.', '-ndr-private.'),
      headers: {
        'user-agent': userAgent,
        'x-nd-auth': `MAC id="${token}",nonce="0",mac="0"`,
      },
    });
  }
  let lastError;
  for (const attempt of attempts) {
    try {
      await writeFile(pdfPath, await fetchBuffer(attempt.url, { headers: attempt.headers }));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to download PDF: ${lastError?.message || lastError}` +
      (token ? '' : '（公开桶不可用；如需从私有桶下载请设置 SMARTEDU_TOKEN）'),
  );
}

// —— 文本层解析 ——

const LESSON_PREFIX = /^第([一二三四五六七八九十百]+)课/;
const UNIT_PREFIX = /^第([一二三四五六七八九十百]+)单元/;

const BOX_LABELS = new Set([
  '生活观察',
  '探究与分享',
  '阅读感悟',
  '方法与技能',
  '知识窗',
  '相关链接',
  '阅读与思考',
  '启思导行',
  '名人名言',
  '专家点评',
  '温馨提示',
  '拓展空间',
  '运用你的经验',
  '示例评析',
  '名词点击',
]);

function isWatermark(line) {
  return line.includes('仅供个人学习使用');
}

function isPageNumberOnly(line) {
  return /^\s*\d+\s*$/.test(line);
}

function isPageHeader(line) {
  const t = line.trim();
  return (
    /^第[一二三四五六七八九十百]+(单元|课)\s+\S.*\d\s*$/.test(t) ||
    /^综合探究[一二三四五]?\s+\S.*\d\s*$/.test(t) ||
    /^单元思考与行动\s+\d+\s*$/.test(t)
  );
}

function isPageFooter(line) {
  const t = line.trim();
  return /^\d+\s+(道德与法治|思想政治|第[一二三四五六七八九十百]+单元|目\s*录)/.test(t);
}

function isDecorativeLine(line) {
  const t = line.trim();
  return /^[●▪○■•*~—\s]+$/.test(t) || /^[●▪○■•]\s*[●▪○■•\s]*$/.test(t);
}

/** 内容页的章节标题行（无尾随页码）。 */
function chapterHeading(line) {
  const t = line.trim();
  const m = t.match(LESSON_PREFIX);
  if (m && !/\d/.test(t.slice(m[0].length))) return { kind: 'lesson', number: chineseNumber(m[1]) };
  if (/^单元思考与行动$/.test(t)) return { kind: 'unit-review' };
  const inquiry = t.match(/^综合探究([一二三四五]?)\s*(.*)$/);
  if (inquiry && !/\d$/.test(t)) return { kind: 'inquiry', index: inquiry[1] || '' };
  if (/^前言$/.test(t)) return { kind: 'preface' };
  if (/^后记$/.test(t)) return { kind: 'afterword' };
  return null;
}

/** 单元分隔页：`第X单元` / `第X单元 标题` / `第X` + `单元 标题`。 */
function unitDivider(lines, index) {
  const t = lines[index].trim();
  const inline = t.match(new RegExp(`^第([${Object.keys(CN_DIGITS).join('')}]+)单元\\s*(.+)$`));
  if (inline && !/\d$/.test(t)) {
    return { number: chineseNumber(inline[1]), title: inline[2].trim(), skipNext: false };
  }
  const bare = t.match(new RegExp(`^第([${Object.keys(CN_DIGITS).join('')}]+)单元$`));
  if (bare) return { number: chineseNumber(bare[1]), title: null, skipNext: false };
  const split = t.match(/^第([一二三四五六七八九十百]+)$/);
  if (split) {
    const next = lines.slice(index + 1).find((line) => line.trim());
    if (next && /^单元/.test(next.trim())) {
      return {
        number: chineseNumber(split[1]),
        title: next.trim().replace(/^单元\s*/, ''),
        skipNext: true,
      };
    }
  }
  return null;
}

function isTocEntryLine(line) {
  const t = line.trim();
  if (!t || /[\u4e00-\u9fff]/.test(t) === false) return false;
  if (isWatermark(t) || /目\s*录/.test(t) || isPageNumberOnly(t)) return false;
  if (/^\d+\s+(道德与法治|思想政治)/.test(t)) return false;
  const m = t.match(/^(.+?)\s+(\d+)\s*$/);
  return Boolean(m && m[1].replace(/\s+/g, '').length >= 2 && !/^\d+\s*$/.test(m[1]));
}

/** 解析目录页，得到 单元/课/框/综合探究 的权威结构。 */
function parseToc(pages, tocStartIndex) {
  const entries = []; // { kind, number?, title, page, unit? }
  let pending = null; // 标题换行的目录条目（课 / 综合探究）
  let contentStart = null;

  const footerNoise = /^\d+\s+(道德与法治|思想政治|第[一二三四五六七八九十百]+单元|目\s*录)/;

  for (let p = tocStartIndex; p < pages.length; p += 1) {
    for (let i = 0; i < pages[p].length; i += 1) {
      const t = pages[p][i].trim();
      if (!t) continue;
      if (footerNoise.test(t) || isWatermark(t) || /目\s*录/.test(t) || isPageNumberOnly(t)) continue;

      // 目录中换行的条目（如「第四课 …才能实现」+「中华民族伟大复兴 43」，
      // 或「综合探究 坚持党的领导、人民当家作主、」+「依法治国有机统一 111」）不是正文起始
      const heading = chapterHeading(t);
      if (heading) {
        const nextLine = pages[p].slice(i + 1).find((line) => line.trim());
        const wrapped = Boolean(nextLine && /\d$/.test(nextLine.trim()));
        if (wrapped && (heading.kind === 'lesson' || heading.kind === 'inquiry')) {
          pending =
            heading.kind === 'lesson'
              ? { kind: 'lesson', number: heading.number, title: normalizeWs(t.replace(LESSON_PREFIX, '')) }
              : { kind: 'inquiry', index: heading.index, title: normalizeWs(t.replace(/^综合探究[一二三四五]?\s*/, '')) };
          continue;
        }
        contentStart = p;
        break;
      }
      if (unitDivider(pages[p], i)) {
        contentStart = p;
        break;
      }
      if (!isTocEntryLine(t)) continue;

      const unit = t.match(/^第([一二三四五六七八九十百]+)单元\s+(.+?)\s+(\d+)\s*$/);
      if (unit) {
        pending = null;
        entries.push({
          kind: 'unit',
          number: chineseNumber(unit[1]),
          title: normalizeWs(unit[2]),
          page: Number(unit[3]),
        });
        continue;
      }

      const lesson = t.match(/^第([一二三四五六七八九十百]+)课\s*(.+?)\s+(\d+)\s*$/);
      if (lesson) {
        pending = null;
        entries.push({
          kind: 'lesson',
          number: chineseNumber(lesson[1]),
          title: normalizeWs(lesson[2]),
          page: Number(lesson[3]),
        });
        continue;
      }

      // 标题换行：以「第X课」/「综合探究」开头、本行无页码（完整条目已在上方匹配）
      if (LESSON_PREFIX.test(t) && !/\d$/.test(t)) {
        pending = {
          kind: 'lesson',
          number: chineseNumber(t.match(LESSON_PREFIX)[1]),
          title: normalizeWs(t.replace(LESSON_PREFIX, '')),
        };
        continue;
      }
      if (/^综合探究/.test(t) && !/\d$/.test(t)) {
        pending = {
          kind: 'inquiry',
          index: t.match(/^综合探究([一二三四五]?)/)[1] || '',
          title: normalizeWs(t.replace(/^综合探究[一二三四五]?\s*/, '')),
        };
        continue;
      }
      if (pending) {
        const continuation = t.match(/^(.+?)\s+(\d+)\s*$/);
        if (continuation) {
          if (pending.kind === 'lesson') {
            entries.push({
              kind: 'lesson',
              number: pending.number,
              title: normalizeWs(`${pending.title}${continuation[1]}`),
              page: Number(continuation[2]),
            });
          } else {
            entries.push({
              kind: 'inquiry',
              index: pending.index,
              title: normalizeWs(`${pending.title}${continuation[1]}`),
              page: Number(continuation[2]),
            });
          }
          pending = null;
          continue;
        }
        pending = null; // 下一行不是页码结尾，放弃续行
      }

      const review = t.match(/^单元思考与行动\s+(\d+)\s*$/);
      if (review) {
        pending = null;
        entries.push({ kind: 'unit-review', title: '单元思考与行动', page: Number(review[1]) });
        continue;
      }

      const inquiry = t.match(/^综合探究([一二三四五]?)\s*(.+?)\s+(\d+)\s*$/);
      if (inquiry) {
        pending = null;
        entries.push({
          kind: 'inquiry',
          index: inquiry[1] || '',
          title: normalizeWs(inquiry[2]),
          page: Number(inquiry[3]),
        });
        continue;
      }

      const section = t.match(/^(.+?)\s+(\d+)\s*$/);
      if (section) {
        pending = null;
        entries.push({ kind: 'section', title: normalizeWs(section[1]), page: Number(section[2]) });
        continue;
      }
    }
    if (contentStart !== null) break;
  }

  // 课号按出现顺序补齐（目录续行条目不携带独立课号）
  let lessonNumber = 0;
  for (const entry of entries) {
    if (entry.kind === 'lesson') {
      lessonNumber += 1;
      entry.number = lessonNumber;
    }
  }

  // 单元归属
  let currentUnit = null;
  for (const entry of entries) {
    if (entry.kind === 'unit') currentUnit = entry;
    else entry.unit = currentUnit;
  }

  // 每课包含的框标题（归一化后）
  const sectionsByLesson = new Map();
  let currentLesson = null;
  for (const entry of entries) {
    if (entry.kind === 'lesson') currentLesson = entry;
    if (entry.kind === 'section' && currentLesson) {
      if (!sectionsByLesson.has(currentLesson.number)) {
        sectionsByLesson.set(currentLesson.number, new Set());
      }
      sectionsByLesson.get(currentLesson.number).add(entry.title);
    }
  }

  return { entries, sectionsByLesson, contentStart };
}

function isNoiseLine(line) {
  return isWatermark(line) || isPageNumberOnly(line) || isPageHeader(line) || isPageFooter(line) || isDecorativeLine(line);
}

/** 解析正文页，按章节切分并清洗文本。 */
function parseContent(pages, toc, headingAllowlist, bookSlug) {
  const sectionsByLesson = toc.sectionsByLesson;
  const chapterTitles = new Map(); // 课号 → 目录课名
  const unitTitles = new Map(); // 单元号 → 目录名
  for (const entry of toc.entries) {
    if (entry.kind === 'lesson') chapterTitles.set(entry.number, entry.title);
    if (entry.kind === 'unit') unitTitles.set(entry.number, entry.title);
  }

  const chapters = [];
  let current = null; // 正在填充的章节
  let currentUnit = null; // { number, title, chapterCount }
  let dropPrefix = ''; // 分隔页标题行的前缀匹配目标
  let dropAccum = ''; // 已丢弃的分隔页标题行（归一化）

  // 综合探究标题按目录出现顺序映射（正文中标题可能与目录序号不一致）
  const tocInquiries = toc.entries.filter((entry) => entry.kind === 'inquiry');
  let inquiryCursor = 0;

  const closeCurrent = () => {
    if (current) chapters.push(current);
    current = null;
  };

  const startChapter = (heading, inlineTitle) => {
    let slug;
    let title;
    let unit;
    if (heading.kind === 'lesson') {
      const tocTitle = chapterTitles.get(heading.number);
      slug = `${bookSlug}-lesson-${String(heading.number).padStart(2, '0')}`;
      title = `第${toChineseNumeral(heading.number)}课 ${tocTitle || inlineTitle || ''}`.trim();
      unit = currentUnit;
      dropPrefix = tocTitle ? normalizeWs(tocTitle) : '';
    } else if (heading.kind === 'unit-review') {
      slug = `${bookSlug}-unit-review-${String(currentUnit?.number ?? 1).padStart(2, '0')}`;
      title = '单元思考与行动';
      unit = currentUnit;
      dropPrefix = '';
    } else if (heading.kind === 'inquiry') {
      const tocInquiry = tocInquiries[inquiryCursor];
      inquiryCursor += 1;
      slug = `${bookSlug}-inquiry-${String(currentUnit?.number ?? inquiryCursor).padStart(2, '0')}`;
      title = `综合探究${heading.index} ${tocInquiry?.title ?? ''}`.trim();
      unit = currentUnit;
      dropPrefix = tocInquiry ? normalizeWs(tocInquiry.title) : '';
    } else {
      slug = heading.kind;
      title = heading.kind === 'preface' ? '前言' : '后记';
      unit = currentUnit;
      dropPrefix = '';
    }
    return {
      kind: heading.kind,
      number: heading.number,
      slug,
      title,
      unit,
      lines: [],
      charCount: 0,
    };
  };

  const pushLine = (line) => {
    if (!current) return;
    current.lines.push(line);
    current.charCount += line.length;
  };

  const contentStart = toc.contentStart ?? 0;
  for (let p = contentStart; p < pages.length; p += 1) {
    const lines = pages[p];
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (!t) {
        // 空白行作为段落分隔标记（每段连续空行只记一个）
        if (current && current.lines.at(-1) !== '') current.lines.push('');
        continue;
      }

      // 单元分隔页 → 「单元导语」章节
      const divider = unitDivider(lines, i);
      if (divider) {
        if (divider.skipNext) i += 1;
        closeCurrent();
        currentUnit = {
          number: divider.number,
          title: divider.title || unitTitles.get(divider.number) || `第${toChineseNumeral(divider.number)}单元`,
          chapterCount: 0,
        };
        current = {
          kind: 'unit-intro',
          number: currentUnit.number,
          slug: `${bookSlug}-unit-${String(currentUnit.number).padStart(2, '0')}-intro`,
          title: `单元导语 · ${currentUnit.title}`,
          unit: currentUnit,
          lines: [],
          charCount: 0,
        };
        dropPrefix = normalizeWs(currentUnit.title);
        dropAccum = '';
        continue;
      }

      // 章节标题
      const heading = chapterHeading(t);
      if (heading) {
        closeCurrent();
        current = startChapter(
          heading,
          heading.kind === 'lesson' ? t.replace(LESSON_PREFIX, '').trim() : '',
        );
        if (currentUnit) currentUnit.chapterCount += 1;
        dropAccum = '';
        continue;
      }

      if (isNoiseLine(t)) continue;

      // 分隔页标题行：累积文本必须是目录标题的前缀才继续丢弃
      // （排版换行处可能多出空格，比较时去掉全部空白）
      const stripWs = (s) => s.replace(/\s+/g, '');
      if (dropPrefix) {
        const candidate = dropAccum ? stripWs(`${dropAccum} ${t}`) : stripWs(t);
        if (stripWs(dropPrefix).startsWith(candidate)) {
          dropAccum = candidate;
          continue;
        }
        dropPrefix = '';
        dropAccum = '';
      }

      // 目录中的框标题 → ##（仅课内）；栏目标签 → 加粗；去装饰符后再判一次
      const norm = normalizeWs(t);
      const bareLabel = t.replace(/^[◆●▪○■*]+\s*/, '');
      const bareNorm = normalizeWs(bareLabel);
      if (current?.kind === 'lesson' && sectionsByLesson.get(current.number)?.has(norm)) {
        pushLine(`## ${norm}`);
        continue;
      }
      if (BOX_LABELS.has(norm) || BOX_LABELS.has(bareNorm)) {
        pushLine(`**${bareNorm}**`);
        continue;
      }
      if (bareLabel !== t && /^[◆●▪○■*]+$/.test(bareLabel.trim())) continue; // 纯装饰行

      // 层级小标题 → ###（白名单，避免图注/人名等误判）
      if (
        current?.kind === 'lesson' &&
        t.length <= 14 &&
        !/[\d。？！…：；]/.test(t) &&
        !/ {2,}/.test(t) &&
        /[\u4e00-\u9fff]{2,}/.test(t) &&
        !BOX_LABELS.has(bareNorm) &&
        !sectionsByLesson.get(current.number)?.has(norm)
      ) {
        if (process.env.TEXTBOOK_DEBUG_CANDIDATES && !headingAllowlist.has(norm)) {
          process.stderr.write(`CANDIDATE ${bookSlug}\t${norm}\n`);
        }
        if (headingAllowlist.has(norm)) {
          pushLine(`### ${norm}`);
          continue;
        }
      }

      // 正文行（压缩连续空格，避免排版列间隙）
      pushLine(t.replace(/ {2,}/g, ' '));
    }
  }
  closeCurrent();

  // 组装正文（段落间空行）
  for (const chapter of chapters) {
    let body = '';
    let blanks = 0;
    for (const line of chapter.lines) {
      if (!line) {
        blanks += 1;
        continue;
      }
      if (blanks > 0) body += '\n\n';
      body += `${line}\n`;
      blanks = 0;
    }
    chapter.body = body.replace(/^\n+/, '').trimEnd() + '\n';
    chapter.charCount = chapter.body.length;
  }

  return chapters;
}

function toChineseNumeral(number) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (number <= 10) return digits[number];
  if (number < 20) return `十${digits[number - 10]}`;
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ''}`;
}

// —— 书籍生成 ——

async function importBook(book, workspace, warnings) {
  const { id, slug, title, subtitle, editionLabel, kind } = book;
  console.log(`\n=== ${title} ${subtitle} ===`);

  const detail = await fetchJson(`${detailJsonBase}/${id}.json`);
  const pdfUrl = publicPdfUrl(detail);
  const pdfPath = join(workspace, `${slug}.pdf`);
  const txtPath = join(workspace, `${slug}.txt`);

  console.log('下载官方电子教材 PDF…');
  await downloadPdf(pdfUrl, pdfPath);

  console.log('提取文本层…');
  await execFileAsync('pdftotext', ['-layout', pdfPath, txtPath]);
  const text = await readFile(txtPath, 'utf8');
  const pages = text
    .split('\f')
    .map((page) => page.split('\n'))
    .filter((page) => page.some((line) => line.trim()));

  const tocHeadingIndex = pages.findIndex((page) => page.some((line) => /^\s*目\s*录\s*$/.test(line.trim())));
  if (tocHeadingIndex < 0) throw new Error(`${slug}: 未找到目录页`);
  const toc = parseToc(pages, tocHeadingIndex);
  if (toc.contentStart === null) throw new Error(`${slug}: 未找到正文起始页`);

  // 校验：目录中的每一课都在正文中出现
  const chapters = parseContent(pages, toc, new Set(HEADING_ALLOWLIST[slug] ?? []), slug);
  const foundLessons = new Set(chapters.filter((c) => c.kind === 'lesson').map((c) => c.number));
  for (const entry of toc.entries.filter((e) => e.kind === 'lesson')) {
    if (!foundLessons.has(entry.number)) warnings.push(`${slug}: 目录第${entry.number}课在正文中未找到`);
  }
  const tocLessons = toc.entries.filter((e) => e.kind === 'lesson').length;
  const foundCount = chapters.filter((c) => c.kind === 'lesson').length;
  if (tocLessons !== foundCount) {
    warnings.push(`${slug}: 目录 ${tocLessons} 课 vs 正文 ${foundCount} 课`);
  }

  // 编号与单元归属
  let chapterNumber = 0;
  let volumeCount = 0;
  for (const chapter of chapters) {
    chapterNumber += 1;
    chapter.chapterNumber = chapterNumber;
    if (chapter.unit) {
      volumeCount = Math.max(volumeCount, chapter.unit.number);
      chapter.volumeNumber = chapter.unit.number;
      chapter.volumeTitle = chapter.unit.title;
    }
    if (!chapter.body || chapter.body.trim().length === 0) {
      warnings.push(`${slug}: 章节 ${chapter.slug} 正文为空`);
    }
  }
  // 单元内序号
  const unitCounters = new Map();
  for (const chapter of chapters) {
    if (!chapter.unit) continue;
    const key = chapter.unit.number;
    const seq = (unitCounters.get(key) ?? 0) + 1;
    unitCounters.set(key, seq);
    chapter.volumeUnitNumber = seq;
  }

  const realVolumeCount = new Set(chapters.map((c) => c.unit?.number).filter(Boolean)).size;
  const unitTitles = toc.entries.filter((e) => e.kind === 'unit');
  const summaryParts = [];
  if (kind === 'junior') {
    summaryParts.push(`义务教育教科书《${title}》${subtitle}，教育部组织编写。`);
  } else {
    summaryParts.push(`普通高中教科书《${title}》${subtitle}，教育部组织编写。`);
  }
  if (unitTitles.length) {
    summaryParts.push(`全书共 ${unitTitles.length} 个单元：${unitTitles.map((u) => u.title).join('；')}。`);
  } else {
    const lessons = toc.entries.filter((e) => e.kind === 'lesson');
    summaryParts.push(`全书共 ${lessons.length} 课：${lessons.map((l) => l.title).join('、')}。`);
  }

  // 封面（PDF 第 1 页）
  const coverRoot = join(repositoryRoot, 'public/images/books', slug);
  await mkdir(coverRoot, { recursive: true });
  await execFileAsync('pdftoppm', [
    '-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to', '520', pdfPath, join(coverRoot, 'cover'),
  ]);

  // 写入内容
  const bookDirectory = join(workspace, 'content', slug);
  const chapterDirectory = join(bookDirectory, 'chapters');
  await mkdir(chapterDirectory, { recursive: true });

  const reports = [];
  for (const chapter of chapters) {
    const filename = `${String(chapter.chapterNumber).padStart(3, '0')}-${chapter.slug}.md`;
    await writeFile(
      join(chapterDirectory, filename),
      `---\n${frontMatter({
        bookSlug: slug,
        chapterNumber: chapter.chapterNumber,
        slug: chapter.slug,
        title: chapter.title,
        sourcePath: pdfUrl,
        volumeNumber: chapter.volumeNumber,
        volumeTitle: chapter.volumeTitle,
        volumeUnitNumber: chapter.volumeUnitNumber,
        unitType: chapter.kind === 'lesson' ? 'chapter' : 'supplement',
      })}\n---\n\n${chapter.body}`,
    );
    reports.push({
      chapterNumber: chapter.chapterNumber,
      slug: chapter.slug,
      title: chapter.title,
      volumeNumber: chapter.volumeNumber ?? null,
      volumeUnitNumber: chapter.volumeUnitNumber ?? null,
      characters: chapter.charCount,
    });
  }

  const rightsNotice =
    '官方电子教材版权页及每页均标注“仅供个人学习使用，未经授权不得另做他用”；' +
    '本整理版本仅作本地个人学习用途，请勿公开部署或传播。正文据官方电子教材 PDF 文本层整理，插图未收录。';
  await writeFile(
    join(bookDirectory, 'book.md'),
    `---\n${frontMatter({
      slug,
      title,
      subtitle,
      author: '教育部组织编写',
      language: 'zh-CN',
      editionLabel,
      summary: summaryParts.join(''),
      sourceUrl: smarteduDetailPage(id),
      sourceName: '国家中小学智慧教育平台（basic.smartedu.cn）',
      rightsNotice,
      cover: `/images/books/${slug}/cover.jpg`,
      volumeCount: realVolumeCount > 0 ? realVolumeCount : undefined,
      chapterCount: chapters.length,
    })}\n---\n`,
  );
  await writeFile(
    join(bookDirectory, 'import-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceId: id,
        sourceUrl: smarteduDetailPage(id),
        title: `${title} ${subtitle}`,
        language: 'zh-CN',
        volumes: realVolumeCount,
        generatedChapters: reports.length,
        characters: reports.reduce((total, chapter) => total + chapter.characters, 0),
        chapters: reports,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `已生成 ${chapters.length} 个章节（${reports.reduce((total, c) => total + c.characters, 0).toLocaleString()} 字符），封面 ${relative(repositoryRoot, join(coverRoot, 'cover.jpg'))}`,
  );
  return reports;
}

async function main() {
  const workspace = await mkdtemp(join(repositoryRoot, '.textbook-import-'));
  const warnings = [];
  let totalChapters = 0;
  let totalCharacters = 0;
  const failed = [];
  // 可选：node scripts/import-textbooks.mjs <slug> 只导入一册（调试用）
  const onlySlug = process.argv[2];
  const books = onlySlug ? BOOKS.filter((book) => book.slug === onlySlug) : BOOKS;
  if (onlySlug && books.length === 0) {
    console.error(`未知图书 slug: ${onlySlug}`);
    process.exitCode = 1;
    return;
  }
  try {
    for (const book of books) {
      try {
        const reports = await importBook(book, workspace, warnings);
        totalChapters += reports.length;
        totalCharacters += reports.reduce((sum, report) => sum + report.characters, 0);
      } catch (error) {
        console.error(`[失败] ${book.slug}: ${error instanceof Error ? error.message : error}`);
        failed.push(book.slug);
      }
    }

    if (warnings.length) {
      console.log('\n=== 警告 ===');
      for (const warning of warnings) console.log(`- ${warning}`);
    } else {
      console.log('\n无警告。');
    }

    // 写入所有成功的书籍（失败的跳过）
    const contentTarget = join(repositoryRoot, 'src/content/books');
    for (const book of books) {
      if (failed.includes(book.slug)) continue;
      const target = join(contentTarget, book.slug);
      await rm(target, { recursive: true, force: true });
      await rename(join(workspace, 'content', book.slug), target);
    }
    const succeeded = books.length - failed.length;
    console.log(
      `\n完成：${succeeded}/${books.length} 册，${totalChapters.toLocaleString()} 个章节，${totalCharacters.toLocaleString()} 字符。`,
    );
    if (failed.length) {
      console.log(`未导入：${failed.join('、')}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

// @ts-nocheck
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import TurndownService from 'turndown';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRevision = '216d406fce11c91834f9402386b55a183c8d491b';
const germanArchiveUrl = `https://codeload.github.com/wertform/mlwerke.de/tar.gz/${sourceRevision}`;
const germanBlobRoot = `https://github.com/wertform/mlwerke.de/blob/${sourceRevision}/me`;
const userAgent = 'Tursom-Log-capital-importer/1.0';

const books = {
  zh: {
    slug: 'capital-zh',
    title: '资本论',
    subtitle: '三卷本 · 中文译文',
    author: '卡尔·马克思',
    category: 'works',
    groupSlug: 'capital',
    groupTitle: '资本论',
    groupOrder: 10,
    seriesOrder: 1,
    translator: '中共中央马克思恩格斯列宁斯大林著作编译局',
    language: 'zh-CN',
    editionLabel: '中文译文',
    alternateEditionSlug: 'capital-de',
    alternateEditionLabel: '德文原文',
    summary: '马克思政治经济学批判的三卷本；第二、三卷由恩格斯根据马克思手稿整理出版。',
    sourceUrl: 'https://www.marxists.org/chinese/marx/capital/',
    sourceName: '中文马克思主义文库',
    rightsNotice:
      '马克思、恩格斯原作已进入公有领域；中文文本据人民出版社1972年及1975年版整理，转载权利仍请按所在地法律与来源站说明核验',
  },
  de: {
    slug: 'capital-de',
    title: 'Das Kapital',
    subtitle: 'Drei Bände · Deutscher Originaltext',
    author: 'Karl Marx',
    category: 'works',
    groupSlug: 'capital',
    groupTitle: '资本论',
    groupOrder: 10,
    seriesOrder: 2,
    language: 'de',
    editionLabel: '德文原文',
    alternateEditionSlug: 'capital-zh',
    alternateEditionLabel: '中文译文',
    summary:
      'Karl Marx’ Kritik der politischen Ökonomie in drei Bänden; Band II und III wurden von Friedrich Engels herausgegeben.',
    sourceUrl: `https://github.com/wertform/mlwerke.de/tree/${sourceRevision}/me`,
    sourceName: 'mlwerke.de 镜像（GitHub）',
    rightsNotice:
      '马克思、恩格斯原作已进入公有领域；电子文本据MEW第23—25卷校录，转载时请注明电子文本来源',
  },
};

const chineseVolumes = [
  {
    number: 1,
    title: '第一卷 资本的生产过程',
    indexUrl: 'https://www.marxists.org/chinese/marx/capital/index.htm',
    sourceRoot: 'https://www.marxists.org/chinese/marx/capital/',
    sourceFiles: Array.from({ length: 26 }, (_, index) => `${String(index).padStart(2, '0')}.htm`),
  },
  {
    number: 2,
    title: '第二卷 资本的流通过程',
    indexUrl:
      'https://www.marxists.org/chinese/marx/capital/marxist.org-chinese-marx-capital-vol2-01.htm',
    sourceRoot: 'https://www.marxists.org/chinese/marx-engels/24/',
    sourceFiles: Array.from(
      { length: 23 },
      (_, index) => `${String(index + 1).padStart(3, '0')}.ht` + 'm',
    ),
  },
  {
    number: 3,
    title: '第三卷 资本主义生产的总过程',
    indexUrl:
      'https://www.marxists.org/chinese/marx/capital/marxist.org-chinese-marx-capital-vol3-01.htm',
    sourceRoot: 'https://www.marxists.org/chinese/marx-engels/25/',
    sourceFiles: Array.from(
      { length: 55 },
      (_, index) => `${String(index + 1).padStart(3, '0')}.ht` + 'm',
    ),
  },
];

const germanVolumes = [
  {
    number: 1,
    title: 'Band I · Der Produktionsprozeß des Kapitals',
    mew: 23,
    prefaces: [
      ['me23_011.htm', 'Vorwort zur ersten Auflage', 'preface-first-edition'],
      ['me23_018.htm', 'Nachwort zur zweiten Auflage', 'preface-second-edition'],
      ['me23_031.htm', 'Vorwort und Nachwort zur französischen Ausgabe', 'preface-french-edition'],
      ['me23_033.htm', 'Zur dritten Auflage', 'preface-third-edition'],
      ['me23_036.htm', 'Vorwort zur englischen Ausgabe', 'preface-english-edition'],
      ['me23_041.htm', 'Zur vierten Auflage', 'preface-fourth-edition'],
    ],
  },
  {
    number: 2,
    title: 'Band II · Der Zirkulationsprozeß des Kapitals',
    mew: 24,
    prefaces: [
      ['me24_007.htm', 'Friedrich Engels · Vorwort', 'preface'],
      ['me24_027.htm', 'Friedrich Engels · Vorwort zur zweiten Auflage', 'preface-second-edition'],
    ],
  },
  {
    number: 3,
    title: 'Band III · Der Gesamtprozeß der kapitalistischen Produktion',
    mew: 25,
    prefaces: [['me25_007.htm', 'Friedrich Engels · Vorwort', 'preface']],
    supplement: ['me25_897.htm', 'Friedrich Engels · Ergänzung und Nachtrag', 'supplement'],
  },
];

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function normalizeText(value) {
  return value.replace(/[\u00a0\s]+/g, ' ').trim();
}

function compactText(value) {
  return normalizeText(value).replaceAll(' ', '');
}

function chineseNumber(value) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value];
  if (value === 10) return '十';
  if (value < 20) return `十${digits[value - 10]}`;
  const tens = Math.floor(value / 10);
  const units = value % 10;
  return `${digits[tens]}十${digits[units]}`;
}

function stripIndexLeader(value) {
  return normalizeText(value)
    .replace(/[…．.]{2,}.*$/u, '')
    .replace(/\s+\d+(?:[—–-]\d+)?\s*$/u, '')
    .trim();
}

async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, 400 * attempt));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function sourcePrefix(language, volumeNumber, sourceUrl) {
  return `${language}-v${volumeNumber}-${basename(new URL(sourceUrl).pathname, extname(new URL(sourceUrl).pathname))}`;
}

function sourceSlug(volumeNumber, kind, numberOrName) {
  if (kind === 'chapter')
    return `volume-${String(volumeNumber).padStart(2, '0')}-chapter-${String(numberOrName).padStart(2, '0')}`;
  return `volume-${String(volumeNumber).padStart(2, '0')}-${numberOrName}`;
}

function makeSourceMap(units) {
  const result = new Map();
  for (const unit of units) {
    for (const source of unit.sources) {
      result.set(source.url, {
        slug: unit.slug,
        prefix: source.prefix,
      });
    }
  }
  return result;
}

function rewriteAnchors(document, source, bookSlug, sourceMap) {
  document('a[name], [id]').each((_, element) => {
    const current = document(element);
    const oldId = current.attr('name') || current.attr('id');
    if (!oldId) return;
    const newId = `${source.prefix}-${oldId}`;
    if (current.is('a')) {
      current.before(`<span id="${newId}"></span>`);
      current.removeAttr('name').removeAttr('id');
    } else {
      current.attr('id', newId);
    }
  });

  document('a[href]').each((_, element) => {
    const anchor = document(element);
    const href = anchor.attr('href');
    if (!href || href.startsWith('mailto:')) return;
    if (href.startsWith('#')) {
      anchor.attr('href', `#${source.prefix}-${href.slice(1)}`);
      return;
    }
    let target;
    try {
      target = new URL(href, source.url);
    } catch {
      return;
    }
    const hash = target.hash;
    target.hash = '';
    const mapped = sourceMap.get(target.href);
    if (mapped) {
      const targetHash = hash ? `#${mapped.prefix}-${hash.slice(1)}` : '';
      anchor.attr('href', `/books/${bookSlug}/${mapped.slug}/${targetHash}`);
      return;
    }
    anchor.attr('href', new URL(href, source.url).href);
  });
}

function removeChineseChrome(document, title) {
  const body = document('body');
  const contents = body.contents().toArray();
  const firstDivider = contents.findIndex((node) => node.type === 'tag' && node.name === 'hr');
  if (firstDivider >= 0) {
    for (const node of contents.slice(0, firstDivider + 1)) document(node).remove();
  }

  body
    .find('p')
    .filter((_, element) => /回目录|上一篇|下一篇/u.test(normalizeText(document(element).text())))
    .remove();
  body.find('script, style, link, hr').remove();

  body.find('table').each((_, element) => {
    const table = document(element);
    const clone = table.clone();
    clone.find('a').remove();
    if (!compactText(clone.text())) table.remove();
  });
  body.find('table, tbody, tr, td, th, div').each((_, element) => {
    const current = document(element);
    if (current.parent().length) current.replaceWith(current.contents());
  });

  const titleKey = compactText(title);
  body.find('p.title0, p.title1').each((_, element) => {
    const current = document(element);
    const text = normalizeText(current.text());
    const key = compactText(text);
    if (!text || key === titleKey || /^第[一二三]卷/u.test(key)) {
      current.remove();
      return;
    }
    current.replaceWith(`<h2>${current.html() || text}</h2>`);
  });
}

function removeGermanChrome(document) {
  const body = document('body');
  body.find('script, style, link').remove();
  body
    .find('p')
    .filter((_, element) => /DOCTYPE/u.test(normalizeText(document(element).text())))
    .remove();
  const pageAnchored = body.find('a[name^="S"]').length > 0;
  if (pageAnchored) {
    let reachedText = false;
    for (const node of body.contents().toArray()) {
      const current = document(node);
      if (current.find('a[name^="S"]').length || current.is('a[name^="S"]')) reachedText = true;
      if (reachedText) continue;
      const isHeader =
        current.is('small') ||
        current.is('p[align="CENTER"], p[align="center"]') ||
        /Seitenzahlen verweisen auf/u.test(normalizeText(current.text()));
      if (isHeader) current.remove();
    }
  }

  body.find('a[name^="S"]').remove();
  body.find('a[href]').each((_, element) => {
    const anchor = document(element);
    if (/me\d+_000\.htm$/iu.test(anchor.attr('href') || '')) anchor.remove();
  });
  body.find('p').each((_, element) => {
    const paragraph = document(element);
    if (/^(Erster|Zweiter) Teil$/u.test(normalizeText(paragraph.text()))) paragraph.remove();
  });
  body.find('a[name^="Kap_"]').each((_, element) => {
    const anchor = document(element);
    const paragraph = anchor.closest('p');
    if (paragraph.length) paragraph.replaceWith(`<h2>${paragraph.html() || anchor.text()}</h2>`);
  });
}

function sanitizeDocument(document) {
  document('font[face="Symbol"], font[face="symbol"]').each((_, element) => {
    const current = document(element);
    const symbols = { D: 'Δ', S: 'Σ', a: 'α', b: 'β', g: 'γ', p: 'π' };
    current.text(
      current
        .text()
        .split('')
        .map((character) => symbols[character] || character)
        .join(''),
    );
  });
  document('font, center').each((_, element) =>
    document(element).replaceWith(document(element).contents()),
  );
  document('*').each((_, element) => {
    const current = document(element);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (
        !['href', 'src', 'alt', 'id', 'colspan', 'rowspan', 'loading', 'decoding'].includes(
          attribute,
        )
      ) {
        current.removeAttr(attribute);
      }
    }
  });
}

function htmlToMarkdown(html, { preserveHardBreaks = false } = {}) {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  turndown.addRule('bookImage', {
    filter: 'img',
    replacement: (_, node) => {
      const image = node;
      const src = image.getAttribute('src') || '';
      const alt = image.getAttribute('alt') || '';
      return `\n\n<img src="${src}" alt="${alt.replaceAll('"', '&quot;')}" loading="lazy" decoding="async" />\n\n`;
    },
  });
  turndown.addRule('namedAnchor', {
    filter: (node) => node.nodeName === 'SPAN' && Boolean(node.getAttribute('id')),
    replacement: (_, node) => `<span id="${node.getAttribute('id')}"></span>`,
  });
  turndown.keep(['sub', 'sup']);
  let markdown = turndown.turndown(html);
  if (!preserveHardBreaks) markdown = markdown.replace(/[ \t]+$/gm, '');
  return markdown
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function materializeImages(document, source, bookSlug, imageOutputRoot, localDirectory) {
  const images = document('img[src]').toArray();
  await mapLimit(images, 4, async (element) => {
    const image = document(element);
    const original = image.attr('src');
    if (!original || original.startsWith('data:')) return;
    const sourceUrl = new URL(original, source.url);
    const originalName = decodeURIComponent(basename(sourceUrl.pathname)) || 'image.bin';
    const extension = extname(originalName).toLowerCase() || '.bin';
    const stem =
      basename(originalName, extension)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 45) || 'image';
    const digest = createHash('sha1').update(sourceUrl.href).digest('hex').slice(0, 10);
    const outputName = `${source.prefix}-${stem}-${digest}${extension}`;
    const outputPath = join(imageOutputRoot, bookSlug, outputName);
    try {
      const bytes = localDirectory
        ? await readFile(join(localDirectory, original.replaceAll('\\', '/')))
        : await fetchBuffer(sourceUrl.href);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      image.attr('src', `/images/books/${bookSlug}/${outputName}`);
      image.attr('loading', 'lazy').attr('decoding', 'async');
    } catch (error) {
      console.warn(`Skipping unavailable image ${sourceUrl.href}: ${error?.message || error}`);
      image.remove();
    }
  });
}

async function convertSource(source, unit, book, sourceMap, imageOutputRoot) {
  const document = load(source.html, { xmlMode: false });
  if (source.language === 'zh') removeChineseChrome(document, unit.title);
  else removeGermanChrome(document);
  await materializeImages(document, source, book.slug, imageOutputRoot, source.localDirectory);
  rewriteAnchors(document, source, book.slug, sourceMap);
  sanitizeDocument(document);
  return htmlToMarkdown(document('body').html() || '', {
    preserveHardBreaks: source.language === 'zh',
  });
}

async function buildChineseUnits() {
  const indexDocuments = await mapLimit(chineseVolumes, 3, async (volume) => ({
    volume,
    html: new TextDecoder('gb18030').decode(await fetchBuffer(volume.indexUrl)),
  }));
  const units = [];

  for (const { volume, html } of indexDocuments) {
    const indexDocument = load(html);
    const titlesByFile = new Map();
    indexDocument('a[href]').each((_, element) => {
      const anchor = indexDocument(element);
      let target;
      try {
        target = new URL(anchor.attr('href'), volume.indexUrl);
      } catch {
        return;
      }
      const filename = basename(target.pathname);
      if (!volume.sourceFiles.includes(filename)) return;
      const title = stripIndexLeader(anchor.text());
      if (title && volume.sourceFiles.includes(filename)) titlesByFile.set(filename, title);
    });

    const sourceFiles =
      volume.number === 3
        ? volume.sourceFiles.filter((file) => file !== '055.htm')
        : volume.sourceFiles;
    for (const [volumeIndex, filename] of sourceFiles.entries()) {
      let kind = 'chapter';
      let slug;
      let title;
      let chapterInVolume;
      let filenames = [filename];

      if (volume.number === 1 && filename === '00.htm') {
        kind = 'preface';
        slug = sourceSlug(volume.number, kind, 'prefaces');
        title = '序言与各版说明';
      } else if (volume.number === 2 && filename === '001.htm') {
        kind = 'preface';
        slug = sourceSlug(volume.number, kind, 'preface');
        title = '弗·恩格斯 · 序言';
      } else if (volume.number === 2 && filename === '002.htm') {
        kind = 'preface';
        slug = sourceSlug(volume.number, kind, 'preface-second-edition');
        title = '弗·恩格斯 · 第二版序言';
      } else if (volume.number === 3 && filename === '001.htm') {
        kind = 'preface';
        slug = sourceSlug(volume.number, kind, 'preface');
        title = '弗里德里希·恩格斯 · 序言';
      } else if (volume.number === 3 && filename === '054.htm') {
        kind = 'supplement';
        slug = sourceSlug(volume.number, kind, 'supplement');
        title = '弗·恩格斯《资本论》第三卷增补';
        filenames = ['054.htm', '055.htm'];
      } else {
        chapterInVolume =
          volume.number === 1
            ? Number(filename.slice(0, 2))
            : Number(filename.slice(0, 3)) - (volume.number === 2 ? 2 : 1);
        slug = sourceSlug(volume.number, kind, chapterInVolume);
        if (volume.number === 1) {
          const rawTitle = (titlesByFile.get(filename) || '').replace(/\s+/g, '');
          title = `第${chineseNumber(chapterInVolume)}章${rawTitle ? ` ${rawTitle}` : ''}`.trim();
        } else {
          title = titlesByFile.get(filename) || `第${chineseNumber(chapterInVolume)}章`;
        }
      }

      units.push({
        language: 'zh',
        volumeNumber: volume.number,
        volumeTitle: volume.title,
        volumeUnitNumber: volumeIndex + 1,
        kind,
        chapterInVolume,
        slug,
        title,
        sources: filenames.map((sourceFilename) => {
          const url = new URL(sourceFilename, volume.sourceRoot).href;
          return { url, prefix: sourcePrefix('zh', volume.number, url), language: 'zh' };
        }),
      });
    }
  }

  await mapLimit(
    units.flatMap((unit) => unit.sources),
    6,
    async (source) => {
      source.html = new TextDecoder('gb18030').decode(await fetchBuffer(source.url));
    },
  );
  return units;
}

function germanChapterTitle(value) {
  return normalizeText(value).replace(/^(\p{L}+ Kapitel)\./u, '$1 ·');
}

async function buildGermanUnits(germanSourceRoot) {
  const units = [];
  for (const volume of germanVolumes) {
    const localDirectory = join(germanSourceRoot, `me${volume.mew}`);
    const indexPath = join(localDirectory, `me${volume.mew}_000.htm`);
    const indexHtml = new TextDecoder('windows-1252').decode(await readFile(indexPath));
    const indexDocument = load(indexHtml);
    const chapterStarts = [];
    const seen = new Set();
    indexDocument('a[href]').each((_, element) => {
      const anchor = indexDocument(element);
      const title = normalizeText(anchor.text());
      const href = (anchor.attr('href') || '').split('#', 1)[0];
      if (
        !/Kapitel/u.test(title) ||
        !new RegExp(`^me${volume.mew}_\\d+\\.htm$`, 'u').test(href) ||
        seen.has(href)
      )
        return;
      seen.add(href);
      chapterStarts.push({ filename: href, title: germanChapterTitle(title) });
    });

    const allNumericFiles = (await readdir(localDirectory))
      .filter((file) => new RegExp(`^me${volume.mew}_\\d+\\.htm$`, 'u').test(file))
      .sort();
    const excluded = new Set([
      ...volume.prefaces.map(([filename]) => filename),
      ...(volume.supplement ? [volume.supplement[0]] : []),
    ]);
    const chapterFiles = allNumericFiles.filter((file) => !excluded.has(file));

    for (const [prefaceIndex, [filename, title, slugName]] of volume.prefaces.entries()) {
      const url = `${germanBlobRoot}/me${volume.mew}/${filename}`;
      units.push({
        language: 'de',
        volumeNumber: volume.number,
        volumeTitle: volume.title,
        volumeUnitNumber: prefaceIndex + 1,
        kind: 'preface',
        slug: `${sourceSlug(volume.number, 'preface', slugName)}-de`,
        title,
        sources: [
          {
            url,
            prefix: sourcePrefix('de', volume.number, url),
            language: 'de',
            localDirectory,
            html: new TextDecoder('windows-1252').decode(
              await readFile(join(localDirectory, filename)),
            ),
          },
        ],
      });
    }

    chapterStarts.forEach((chapter, index) => {
      const nextStart = chapterStarts[index + 1]?.filename;
      const filenames = chapterFiles.filter(
        (filename) => filename >= chapter.filename && (!nextStart || filename < nextStart),
      );
      units.push({
        language: 'de',
        volumeNumber: volume.number,
        volumeTitle: volume.title,
        volumeUnitNumber: volume.prefaces.length + index + 1,
        kind: 'chapter',
        chapterInVolume: index + 1,
        slug: `${sourceSlug(volume.number, 'chapter', index + 1)}-de`,
        title: chapter.title,
        sources: filenames.map((filename) => {
          const url = `${germanBlobRoot}/me${volume.mew}/${filename}`;
          return {
            url,
            prefix: sourcePrefix('de', volume.number, url),
            language: 'de',
            localDirectory,
            html: undefined,
            filename,
          };
        }),
      });
    });

    if (volume.supplement) {
      const [filename, title, slugName] = volume.supplement;
      const url = `${germanBlobRoot}/me${volume.mew}/${filename}`;
      units.push({
        language: 'de',
        volumeNumber: volume.number,
        volumeTitle: volume.title,
        volumeUnitNumber: volume.prefaces.length + chapterStarts.length + 1,
        kind: 'supplement',
        slug: `${sourceSlug(volume.number, 'supplement', slugName)}-de`,
        title,
        sources: [
          {
            url,
            prefix: sourcePrefix('de', volume.number, url),
            language: 'de',
            localDirectory,
            html: new TextDecoder('windows-1252').decode(
              await readFile(join(localDirectory, filename)),
            ),
          },
        ],
      });
    }
  }

  await mapLimit(
    units.flatMap((unit) => unit.sources).filter((source) => !source.html),
    8,
    async (source) => {
      source.html = new TextDecoder('windows-1252').decode(
        await readFile(join(source.localDirectory, source.filename)),
      );
    },
  );
  return units;
}

async function writeBook(book, units, contentOutputRoot, imageOutputRoot) {
  const sourceMap = makeSourceMap(units);
  const chapterDirectory = join(contentOutputRoot, book.slug, 'chapters');
  await mkdir(chapterDirectory, { recursive: true });
  const reports = [];

  for (const [index, unit] of units.entries()) {
    const markdownParts = [];
    for (const source of unit.sources) {
      markdownParts.push(await convertSource(source, unit, book, sourceMap, imageOutputRoot));
    }
    const markdown = markdownParts.filter(Boolean).join('\n\n---\n\n');
    if (!markdown) throw new Error(`${book.slug}/${unit.slug} produced no text`);
    const chapterNumber = index + 1;
    const filename = `${String(chapterNumber).padStart(3, '0')}-${unit.slug}.md`;
    const hasParallel = unit.kind === 'chapter' || unit.volumeNumber > 1;
    const parallelSlug = hasParallel
      ? book.language === 'de'
        ? unit.slug.replace(/-de$/, '')
        : `${unit.slug}-de`
      : undefined;
    await writeFile(
      join(chapterDirectory, filename),
      `---\n${frontMatter({
        bookSlug: book.slug,
        chapterNumber,
        slug: unit.slug,
        title: unit.title,
        sourcePath: unit.sources[0].url,
        volumeNumber: unit.volumeNumber,
        volumeTitle: unit.volumeTitle,
        volumeUnitNumber: unit.volumeUnitNumber,
        unitType: unit.kind,
        parallelSlug,
      })}\n---\n\n${markdown}\n`,
    );
    reports.push({
      chapterNumber,
      slug: unit.slug,
      title: unit.title,
      volumeNumber: unit.volumeNumber,
      sourcePaths: unit.sources.map((source) => source.url),
      characters: markdown.length,
    });
  }

  await writeFile(
    join(contentOutputRoot, book.slug, 'book.md'),
    `---\n${frontMatter({
      slug: book.slug,
      title: book.title,
      subtitle: book.subtitle,
      author: book.author,
      category: book.category,
      groupSlug: book.groupSlug,
      groupTitle: book.groupTitle,
      groupOrder: book.groupOrder,
      seriesOrder: book.seriesOrder,
      translator: book.translator,
      language: book.language,
      editionLabel: book.editionLabel,
      alternateEditionSlug: book.alternateEditionSlug,
      alternateEditionLabel: book.alternateEditionLabel,
      summary: book.summary,
      sourceUrl: book.sourceUrl,
      sourceName: book.sourceName,
      rightsNotice: book.rightsNotice,
      cover: null,
      volumeCount: 3,
      chapterCount: units.length,
    })}\n---\n`,
  );
  await writeFile(
    join(contentOutputRoot, book.slug, 'import-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceRevision: book.language === 'de' ? sourceRevision : undefined,
        title: book.title,
        language: book.language,
        volumes: 3,
        generatedChapters: units.length,
        characters: reports.reduce((total, chapter) => total + chapter.characters, 0),
        chapters: reports,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const workspace = await mkdtemp(join(repositoryRoot, '.capital-import-'));
  try {
    const contentOutputRoot = join(workspace, 'content');
    const imageOutputRoot = join(workspace, 'images');
    const archivePath = join(workspace, 'mlwerke.tar.gz');
    const germanExtractRoot = join(workspace, 'mlwerke');
    await mkdir(contentOutputRoot, { recursive: true });
    await mkdir(imageOutputRoot, { recursive: true });
    await mkdir(germanExtractRoot, { recursive: true });

    console.log('Downloading pinned mlwerke.de source archive…');
    await writeFile(archivePath, await fetchBuffer(germanArchiveUrl));
    await execFileAsync('tar', [
      'xzf',
      archivePath,
      '-C',
      germanExtractRoot,
      '--strip-components=1',
    ]);

    console.log('Reading source indexes and downloading Chinese text…');
    const [chineseUnits, germanUnits] = await Promise.all([
      buildChineseUnits(),
      buildGermanUnits(join(germanExtractRoot, 'me')),
    ]);
    console.log(
      `Converting ${chineseUnits.length} Chinese and ${germanUnits.length} German reading units…`,
    );
    await writeBook(books.zh, chineseUnits, contentOutputRoot, imageOutputRoot);
    await writeBook(books.de, germanUnits, contentOutputRoot, imageOutputRoot);

    for (const book of Object.values(books)) {
      const contentTarget = join(repositoryRoot, 'src/content/books', book.slug);
      const imageTarget = join(repositoryRoot, 'public/images/books', book.slug);
      await rm(contentTarget, { recursive: true, force: true });
      await rm(imageTarget, { recursive: true, force: true });
      await mkdir(dirname(contentTarget), { recursive: true });
      await mkdir(dirname(imageTarget), { recursive: true });
      await rename(join(contentOutputRoot, book.slug), contentTarget);
      const generatedImages = join(imageOutputRoot, book.slug);
      await mkdir(generatedImages, { recursive: true });
      await rename(generatedImages, imageTarget);
    }

    console.log(`Imported ${chineseUnits.length + germanUnits.length} reading units.`);
    console.log(
      `Content: ${relative(repositoryRoot, join(repositoryRoot, 'src/content/books/capital-zh'))}`,
    );
    console.log(
      `Content: ${relative(repositoryRoot, join(repositoryRoot, 'src/content/books/capital-de'))}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

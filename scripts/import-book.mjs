// @ts-nocheck
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { load } from 'cheerio';
import TurndownService from 'turndown';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultInput =
  '/export/raid/document/books/枪炮、病菌与钢铁——人类社会的命运/枪炮、病菌与钢铁——人类社会的命运.epub';
const inputPath = resolve(process.argv[2] || defaultInput);
const bookSlug = 'guns-germs-steel';
const contentRoot = join(repositoryRoot, 'src/content/books', bookSlug);
const chapterRoot = join(contentRoot, 'chapters');
const imageRoot = join(repositoryRoot, 'public/images/books', bookSlug);

const textDecoder = new TextDecoder('utf-8');

function readEntry(entries, name) {
  const bytes = entries[name];
  if (!bytes) throw new Error(`EPUB entry not found: ${name}`);
  return textDecoder.decode(bytes);
}

function normalizeWhitespace(value) {
  return value.replace(/[\u00a0\s]+/g, ' ').trim();
}

function chineseNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (value === '十') return 10;
  if (value.length === 1) return digits[value] ?? 0;
  if (value.startsWith('十')) return 10 + (digits[value[1]] ?? 0);
  if (value.includes('十')) return (digits[value[0]] ?? 0) * 10 + (digits[value[2]] ?? 0);
  return value.split('').reduce((total, digit) => total * 10 + (digits[digit] ?? 0), 0);
}

function safeSlug(title, index) {
  const normalized = normalizeWhitespace(title);
  if (normalized.startsWith('前言')) return 'preface-yali-question';
  if (normalized.startsWith('后记')) return 'afterword';
  const chapter = normalized.match(/^第([一二三四五六七八九十百]+)章/);
  if (chapter) return `chapter-${String(chineseNumber(chapter[1])).padStart(2, '0')}`;
  const part = normalized.match(/^第([一二三四五六七八九十百]+)部分/);
  if (part) return `part-${String(chineseNumber(part[1])).padStart(2, '0')}`;
  if (/^(封面|封二|封三|封底|标题页|书前插图|出版说明|目录)/.test(normalized)) {
    return `front-matter-${String(index).padStart(2, '0')}`;
  }
  return `section-${String(index).padStart(2, '0')}`;
}

function parseNavPoint(node) {
  const label = normalizeWhitespace(node.children('navLabel').children('text').text());
  const source = node.children('content').attr('src') || '';
  const children = node
    .children('navPoint')
    .toArray()
    .flatMap((child) => parseNavPoint(load(child, { xmlMode: true })('navPoint').first()));
  return [{ title: label, source }, ...children];
}

function parseNavigation(ncx) {
  const document = load(ncx, { xmlMode: true });
  return document('navMap > navPoint')
    .toArray()
    .flatMap((node) => parseNavPoint(document(node)));
}

function resolveZipPath(source) {
  return source.split('#', 1)[0].replaceAll('\\', '/').replace(/^\.\//, '');
}

function parseManifest(opf) {
  const document = load(opf, { xmlMode: true });
  const metadata = document('metadata');
  const title = normalizeWhitespace(
    metadata.children('dc\\:title').text() || metadata.find('title').text(),
  );
  const author = normalizeWhitespace(
    metadata.children('dc\\:creator').text() || metadata.find('creator').text(),
  );
  const language = normalizeWhitespace(metadata.children('dc\\:language').text());
  const publishedAt = normalizeWhitespace(metadata.children('dc\\:date').text());
  const manifest = new Map();
  document('manifest > item').each((_, item) => {
    const current = document(item);
    const id = current.attr('id');
    const href = current.attr('href');
    if (id && href) manifest.set(id, resolveZipPath(href));
  });
  const spine = document('spine > itemref')
    .toArray()
    .map((item) => manifest.get(document(item).attr('idref')))
    .filter(Boolean);
  return { title, author, language, publishedAt, manifest, spine };
}

function inferredTitle(sourcePath, index) {
  const split = sourcePath.match(/part0004_split_(\d+)\.html$/);
  if (split) return `书前插图 ${Number(split[1]) + 1}`;
  const appendixTitles = {
    'part0033.html': '出版信息（CIP）',
    'part0034.html': '原版与译本信息',
    'part0035.html': '世纪人文系列丛书（2005年）',
    'part0036.html': '世纪人文系列丛书（2006年）',
  };
  return appendixTitles[sourcePath.split('/').pop()] || `附录 ${String(index).padStart(2, '0')}`;
}

function copyImageReferences(html, sourcePath, entries, imageMap) {
  const document = load(`<div id="chapter-root">${html}</div>`, { xmlMode: true });
  document('#chapter-root img').each((_, element) => {
    const image = document(element);
    const source = image.attr('src');
    if (!source) return;
    const sourceFile = resolveZipPath(join(dirname(sourcePath), source));
    const bytes = entries[sourceFile];
    if (!bytes) return;
    const extension = extname(sourceFile).toLowerCase() || '.jpg';
    const imageName = `${String(imageMap.size + 1).padStart(4, '0')}${extension}`;
    imageMap.set(sourceFile, { bytes, outputName: join(imageRoot, imageName) });
    image.attr('src', `/images/books/${bookSlug}/${imageName}`);
  });
  return document('#chapter-root').html() || '';
}

function htmlToMarkdown(html, title, sourcePath, chapterSlugs) {
  const document = load(`<div id="chapter-root">${html}</div>`, { xmlMode: true });
  const root = document('#chapter-root');
  root.find('script, style, nav').remove();
  root.find('[id^="calibre_pb"]').remove();
  root.find('*').removeAttr('class').removeAttr('style').removeAttr('id');
  root.find('a[href]').each((_, element) => {
    const anchor = document(element);
    const href = anchor.attr('href');
    if (!href || href.startsWith('#')) return;
    const [target] = href.split('#', 2);
    const targetPath = resolveZipPath(join(dirname(sourcePath), target));
    const targetSlug = chapterSlugs.get(targetPath);
    if (targetSlug) anchor.attr('href', `/books/${bookSlug}/${targetSlug}/`);
  });
  const firstHeading = root.find('h1, h2, h3').first();
  if (
    firstHeading.length &&
    normalizeWhitespace(firstHeading.text()) === normalizeWhitespace(title)
  ) {
    firstHeading.remove();
  }
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  turndown.addRule('bookImage', {
    filter: 'img',
    replacement: (_, node) => {
      const image = node;
      const src = image.getAttribute('src') || '';
      const alt = image.getAttribute('alt') || '';
      return `<img src="${src}" alt="${alt}" loading="lazy" decoding="async" />`;
    },
  });
  turndown.keep(['sub', 'sup']);
  return turndown
    .turndown(root.html() || '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(entry, sourcePath) {
  const document = load(entry, { xmlMode: true });
  const body = document('body');
  if (!body.length) return { html: '', text: '', sourcePath };
  const html = body.html() || '';
  return { html, text: normalizeWhitespace(body.text()), sourcePath };
}

function frontMatter(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

async function main() {
  const epub = await readFile(inputPath);
  const entries = unzipSync(new Uint8Array(epub));
  const container = load(readEntry(entries, 'META-INF/container.xml'), { xmlMode: true });
  const opfPath = container('rootfile').attr('full-path');
  if (!opfPath) throw new Error('EPUB container has no OPF path');
  const opf = readEntry(entries, opfPath);
  const { title: rawTitle, author, language, publishedAt, manifest, spine } = parseManifest(opf);
  const title = rawTitle.replace(/\s*:\s*人类社会的命运.*$/, '').trim() || '枪炮、病菌与钢铁';
  const ncxPath = [...manifest.values()].find((path) => path.endsWith('toc.ncx')) || 'toc.ncx';
  const navigation = parseNavigation(readEntry(entries, ncxPath));
  if (navigation.length === 0) throw new Error('EPUB navigation contains no entries');
  const navigationBySource = new Map(
    navigation.map((item) => [resolveZipPath(join(dirname(ncxPath), item.source)), item]),
  );
  const orderedEntries = spine.map(
    (sourcePath, index) =>
      navigationBySource.get(sourcePath) || {
        title: inferredTitle(sourcePath, index + 1),
        source: sourcePath,
      },
  );
  for (const item of navigation) {
    const sourcePath = resolveZipPath(join(dirname(ncxPath), item.source));
    if (!spine.includes(sourcePath)) orderedEntries.push(item);
  }

  // The EPUB stores each front illustration as a separate spine document. Keep
  // the images in source order, but present the consecutive set as one reading unit.
  const groupedEntries = [];
  for (const item of orderedEntries) {
    const isFrontIllustration = /^书前插图(?:\s+\d+)?$/.test(normalizeWhitespace(item.title));
    const previous = groupedEntries.at(-1);
    if (isFrontIllustration && previous?.group === 'front-illustrations') {
      previous.items.push(item);
      continue;
    }
    groupedEntries.push({
      title: isFrontIllustration ? '书前插图' : item.title,
      source: item.source,
      items: [item],
      group: isFrontIllustration ? 'front-illustrations' : undefined,
    });
  }
  const chapterSlugs = new Map();
  groupedEntries.forEach((item, index) => {
    const slug = safeSlug(item.title, index + 1);
    for (const sourceItem of item.items) {
      chapterSlugs.set(resolveZipPath(join(dirname(ncxPath), sourceItem.source)), slug);
    }
  });

  const chapters = [];
  const imageMap = new Map();
  const skippedEntries = [];
  const emptyEntries = [];
  for (const [index, item] of groupedEntries.entries()) {
    const markdownParts = [];
    const sourcePaths = [];
    let hasImage = false;
    const emptyItems = [];
    for (const sourceItem of item.items) {
      const sourcePath = resolveZipPath(join(dirname(ncxPath), sourceItem.source));
      const source = entries[sourcePath];
      if (!source) throw new Error(`Navigation source not found: ${sourceItem.source}`);
      const body = extractBody(textDecoder.decode(source), sourcePath);
      if (!body.text && !body.html.includes('<img')) {
        emptyItems.push({ title: sourceItem.title, sourcePath });
        continue;
      }
      const html = copyImageReferences(body.html, sourcePath, entries, imageMap);
      const markdownPart = htmlToMarkdown(html, sourceItem.title, sourcePath, chapterSlugs);
      if (markdownPart) markdownParts.push(markdownPart);
      hasImage ||= html.includes('<img');
      sourcePaths.push(sourcePath);
    }
    const sourcePath = sourcePaths[0] || resolveZipPath(join(dirname(ncxPath), item.source));
    let markdown = markdownParts.join('\n\n');
    if (!markdown && /^第[一二三四五六七八九十百]+部分/.test(item.title))
      markdown = `## ${item.title}`;
    if (!markdown && !hasImage) {
      for (const emptyItem of emptyItems) {
        skippedEntries.push({ reason: 'empty', ...emptyItem });
        emptyEntries.push(emptyItem);
      }
      continue;
    }
    chapters.push({
      number: chapters.length + 1,
      slug: safeSlug(item.title, index + 1),
      title: item.title,
      sourcePath,
      sourcePaths,
      markdown,
    });
  }
  if (chapters.length === 0) throw new Error('EPUB produced no readable chapters');

  await rm(contentRoot, { recursive: true, force: true });
  await rm(imageRoot, { recursive: true, force: true });
  await mkdir(chapterRoot, { recursive: true });
  await mkdir(imageRoot, { recursive: true });

  const coverEntry = entries['cover.jpeg'] || entries['OEBPS/cover.jpeg'];
  let coverPath = null;
  if (coverEntry) {
    coverPath = `/images/books/${bookSlug}/cover.jpeg`;
    await writeFile(join(imageRoot, 'cover.jpeg'), coverEntry);
  }
  for (const image of imageMap.values()) await writeFile(image.outputName, image.bytes);

  await writeFile(
    join(contentRoot, 'book.md'),
    `---\n${frontMatter({
      slug: bookSlug,
      title,
      subtitle: '人类社会的命运',
      author,
      language: language === 'zh' ? 'zh-CN' : language || 'zh-CN',
      publishedAt: publishedAt || null,
      translator: '谢延光',
      summary: '关于人类社会差异、农业、技术与历史发展路径的综合历史论述。',
      sourceUrl: 'https://www.99csw.com/book/6380/index.htm',
      sourceName: '99csw.com',
      rightsNotice: '公开部署前请确认正文与插图的转载许可范围',
      cover: coverPath,
      chapterCount: chapters.length,
    })}\n---\n`,
  );
  for (const chapter of chapters) {
    const filename = `${String(chapter.number).padStart(3, '0')}-${chapter.slug}.md`;
    await writeFile(
      join(chapterRoot, filename),
      `---\n${frontMatter({
        bookSlug,
        chapterNumber: chapter.number,
        slug: chapter.slug,
        title: chapter.title,
        sourcePath: chapter.sourcePath,
      })}\n---\n\n${chapter.markdown}\n`,
    );
  }

  const report = {
    input: basename(inputPath),
    title,
    author,
    navigationEntries: navigation.length,
    spineEntries: spine.length,
    orderedEntries: orderedEntries.length,
    generatedChapters: chapters.length,
    skippedEntries: skippedEntries.length,
    emptyEntries,
    images: imageMap.size + (coverEntry ? 1 : 0),
    imageReferences: [...imageMap.entries()].map(([sourcePath, image]) => ({
      sourcePath,
      outputPath: relative(repositoryRoot, image.outputName),
    })),
    chapters: chapters.map(({ number, slug, title: chapterTitle, sourcePath, sourcePaths }) => ({
      number,
      slug,
      title: chapterTitle,
      sourcePath,
      ...(sourcePaths.length > 1 ? { sourcePaths } : {}),
    })),
  };
  await writeFile(join(contentRoot, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Imported ${chapters.length} chapters and ${report.images} images from ${inputPath}`);
  console.log(`Report: ${relative(repositoryRoot, join(contentRoot, 'import-report.json'))}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

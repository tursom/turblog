// @ts-nocheck
// Import Stephen Baxter's Xeelee books as password-protected reading content.
//
// Usage:
//   node scripts/import-xeelee.mjs --from-dir tmp  # local EPUB/PDF files
//   node scripts/import-xeelee.mjs --free          # author-authorized Raft short story
//
// Local source files are read in place and are never copied into the repository. The
// importer rebuilds only the Xeelee book directories named in LOCAL_BOOKS.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadHtml } from 'cheerio';
import { unzipSync } from 'fflate';
import TurndownService from 'turndown';

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userAgent = 'Tursom-Log-xeelee-importer/2.0';
const textDecoder = new TextDecoder('utf-8');

const author = 'Stephen Baxter';
const groupSlug = 'xeelee-sequence';
const groupTitle = 'Xeelee Sequence';
const groupOrder = 40;
const language = 'en';
const sourceUrl = 'https://www.stephen-baxter.com/';
const privateRightsNotice =
  "Copyright Stephen Baxter. This extracted text is stored for the site owner's private reading only and must not be publicly distributed.";

const LOCAL_BOOKS = [
  {
    filename: 'Raft_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'raft',
    title: 'Raft',
    subtitle: 'Xeelee Sequence 1',
    publishedAt: '1991-01-01',
    seriesOrder: 1,
    summary:
      'Rees leaves the Belt and discovers the fragile societies living in a universe where gravity is a billion times stronger than on Earth.',
    minimumChapters: 16,
    minimumCharacters: 400_000,
  },
  {
    filename: '783418290-Stephen-Baxter-Xeelee-2-Timelike-Infinity-PDFDrive.pdf',
    format: 'pdf',
    slug: 'timelike-infinity',
    title: 'Timelike Infinity',
    subtitle: 'Xeelee Sequence 2',
    publishedAt: '1992-01-01',
    seriesOrder: 2,
    summary:
      'Human rebels use a wormhole sent back through time as they resist the Qax occupation of Earth.',
    minimumChapters: 16,
    minimumCharacters: 250_000,
  },
  {
    filename: 'Flux_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'flux',
    title: 'Flux',
    subtitle: 'Xeelee Sequence 3',
    publishedAt: '1993-01-01',
    seriesOrder: 3,
    summary:
      'Microscopic human descendants struggle to survive inside the turbulent mantle of a neutron star.',
    minimumChapters: 29,
    minimumCharacters: 500_000,
  },
  {
    filename: 'Ring_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'ring',
    title: 'Ring',
    subtitle: 'Xeelee Sequence 4',
    publishedAt: '1994-01-01',
    seriesOrder: 4,
    summary:
      'Across immense spans of time, human explorers pursue the Xeelee and confront the photino birds reshaping the universe.',
    minimumChapters: 35,
    minimumCharacters: 500_000,
    volumePattern: /^PART\s+[IVX]+\b/i,
    excludedTitles: new Set(['Annotation']),
  },
  {
    filename: 'Vacuum_Diagrams_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'vacuum-diagrams',
    title: 'Vacuum Diagrams',
    subtitle: 'Stories from the Xeelee Sequence',
    publishedAt: '1997-01-01',
    seriesOrder: 5,
    summary:
      'A linked collection tracing humanity and the Xeelee across the vast chronology of the sequence.',
    minimumChapters: 25,
    minimumCharacters: 500_000,
    volumePattern: /^PART\s+\d+\b/i,
  },
  {
    filename: 'Mayflower_II_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'mayflower-ii',
    title: 'Mayflower II',
    subtitle: 'A Xeelee Sequence novella',
    publishedAt: '2004-01-01',
    seriesOrder: 6,
    summary:
      'A generation ship and its changing human society travel through thousands of years toward an uncertain refuge.',
    minimumChapters: 10,
    minimumCharacters: 100_000,
  },
  {
    filename: 'Xeelee_Endurance_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'xeelee-endurance',
    title: 'Xeelee: Endurance',
    subtitle: 'Stories from the Xeelee Sequence',
    publishedAt: '2015-01-01',
    seriesOrder: 7,
    summary:
      "A collection spanning the Xeelee timeline, from Michael Poole and Titan to humanity in the universe's deep future.",
    minimumChapters: 45,
    minimumCharacters: 500_000,
    sectionTitles: new Set([
      'RETURN TO TITAN',
      'STARFALL',
      'REMEMBRANCE',
      'ENDURANCE',
      'THE SEER AND THE SILVERMAN',
      'GRAVITY DREAMS',
      'PERIANDRY’S QUEST',
      'CLIMBING THE BLUE',
      'THE TIME PIT',
      'THE LOWLAND EXPEDITION',
      'FORMIDABLE CARESS',
      'THE XEELEE SEQUENCE – TIMELINE',
    ]),
    useVolumeTitleForUnnavigated: true,
  },
  {
    filename: 'Xeelee__Vengeance_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'xeelee-vengeance',
    title: 'Xeelee: Vengeance',
    subtitle: 'A Xeelee Sequence novel',
    publishedAt: '2017-01-01',
    seriesOrder: 8,
    summary:
      'Michael Poole faces a Xeelee incursion and a threat reaching across the history of the Solar System.',
    minimumChapters: 68,
    minimumCharacters: 500_000,
    volumePattern: /^(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN)$/i,
    titleOverrides: { 'text/part0077.html': 'Coda' },
  },
  {
    filename: 'Xeelee_Redemption_-_Stephen_Baxter.epub',
    format: 'epub',
    slug: 'xeelee-redemption',
    title: 'Xeelee: Redemption',
    subtitle: 'A Xeelee Sequence novel',
    publishedAt: '2018-01-01',
    seriesOrder: 9,
    summary:
      "Jophiel Poole and the crew of the Cauchy cross deep time in humanity's continuing struggle with the Xeelee.",
    minimumChapters: 80,
    minimumCharacters: 600_000,
    volumePattern: /^(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN)$/i,
  },
];

const PROOFREADING_CORRECTIONS = {
  raft: [
    { from: 'a billon times larger', to: 'a billion times larger' },
    { from: 'Jamie worked his controls', to: 'Jame worked his controls' },
    { from: 'Palis squinted', to: 'Pallis squinted' },
    { from: 'We’re progessing', to: 'We’re progressing' },
    { from: 'reflex and adaptabilty', to: 'reflex and adaptability' },
  ],
  'timelike-infinity': [
    { from: 'a salmon-pink backgrounds', to: 'a salmon-pink background' },
    { from: 'the flitters lower hull', to: "the flitter's lower hull" },
    { from: 'Schwarzchild', to: 'Schwarzschild', expected: 2 },
    {
      from: 'The intention of these rebels is surety',
      to: 'The intention of these rebels is surely',
    },
    { from: "they certainty weren't", to: "they certainly weren't" },
    { from: 'description for a special solution', to: 'description of a special solution' },
    { from: 'rights-for- AIs', to: 'rights-for-AIs' },
    { from: 'chance well have', to: "chance we'll have" },
    { from: 'Then well have died', to: "Then we'll have died" },
    { from: 'a miniscule base', to: 'a minuscule base' },
    { from: 'for special longevity', to: 'for species longevity' },
    { from: 'there was grandeur to be a Spline', to: 'there was grandeur in being a Spline' },
    { from: 'Kerr- Newman', to: 'Kerr-Newman' },
    { from: 'shortlived, exotic particles', to: 'short-lived, exotic particles' },
    { from: 'intent on destroy ing humanity', to: 'intent on destroying humanity' },
    { from: 'blue-violent rain', to: 'blue-violet rain' },
  ],
  flux: [
    { from: 'All around her, filing the Air', to: 'All around her, filling the Air' },
    {
      from: 'Adda glided up the line to her, her face alert',
      to: 'Adda glided up the line to her, his face alert',
    },
    { from: 'erupting from its comer', to: 'erupting from its corner' },
    { from: 'returned to Para City', to: 'returned to Parz City' },
    { from: 'Could it he causing the Glitches', to: 'Could it be causing the Glitches' },
    { from: 'the torus of voracity', to: 'the torus of vorticity' },
    {
      from: 'It was a litany intended to conciliate and heal.',
      to: 'It was a litany intended to conciliate and heal.\n\nThe two Human Beings, Waving strongly, joined the shoal of people converging on the Wheel. Around them, the shimmering vortex lines marched steadily across the sky, renewed and strong.',
    },
  ],
  ring: [
    { from: 'the skin peeked by liver-spots', to: 'the skin pocked by liver-spots' },
    { from: 'from the comer of your eye', to: 'from the corner of your eye' },
    { from: 'With modem technology', to: 'With modern technology' },
    { from: 'laid a finder over his lips', to: 'laid a finger over his lips' },
    { from: 'connective', to: 'convective', expected: 3 },
    { from: 'through rime, and space', to: 'through time, and space' },
    { from: 'lost-beyond recognition', to: 'lost beyond recognition' },
    { from: 'Spinner-or-Rope', to: 'Spinner-of-Rope' },
    { from: 'four stout walk about them', to: 'four stout walls about them' },
    {
      from: 'within the attaching superstructure. Spinner',
      to: 'within the attaching superstructure, Spinner',
    },
    { from: 'gravitational tensing', to: 'gravitational lensing', expected: 2 },
    { from: 'expressions tike mirror images', to: 'expressions like mirror images' },
  ],
  'mayflower-ii': [
    { from: '\\`', to: '‘', expected: 368 },
    { from: 'na�ve', to: 'naïve' },
  ],
  'xeelee-vengeance': [
    { from: 'Marsdsen seemed', to: 'Marsden seemed' },
    { from: 'in the planetory system', to: 'in the planetary system' },
    { from: 'within the orbit of Nepture', to: 'within the orbit of Neptune' },
    {
      from: 'Martian space elevators are discussed in Leaving the Planet by Space Elevator by C. C. Edwards and P. Ragan (Lulu.com, 2006). Martian space elevators are discussed in Leaving the Planet by Space Elevator by C. C. Edwards and P. Ragan (Lulu.com, 2006).',
      to: 'Martian space elevators are discussed in Leaving the Planet by Space Elevator by C. C. Edwards and P. Ragan (Lulu.com, 2006).',
    },
  ],
  'xeelee-redemption': [
    { from: 'a smatter of applause', to: 'a smattering of applause' },
    { from: 'gatherred in the dips', to: 'gathered in the dips' },
    { from: 'Different physic-al forces', to: 'Different physical forces' },
    { from: 'Wheel’s constructon', to: 'Wheel’s construction' },
    {
      from: 'This is clearly deriving from your upload',
      to: 'This is clearly derived from your upload',
    },
    { from: 'en routre', to: 'en route' },
    { from: 'Jopohiel was impressed', to: 'Jophiel was impressed' },
    { from: 'over anther right-angle', to: 'over another right-angle' },
    { from: 'Certainly it is must be generations', to: 'Certainly it must be generations' },
    { from: 'It did make made sense', to: 'It did make sense' },
    {
      from: 'If that’s not redemption for doesn’t heal him, nothing will be.',
      to: 'If that’s not redemption for him, nothing will be.',
    },
  ],
};

const FREE_STORIES = [
  {
    bookSlug: 'xeelee-raft',
    title: 'Raft (Short Story)',
    subtitle: 'Xeelee Sequence original short story',
    url: 'https://www.infinityplus.co.uk/stories/raft.htm',
    sourceName: 'Infinity Plus (author-authorized free publication)',
    rightsNotice:
      "Raft copyright Stephen Baxter 1989/1997 and published free by Infinity Plus with the author's permission. Retain the author credit and source; do not redistribute this stored copy.",
    editionLabel: 'Author-authorized short story, first published in Interzone in 1989',
    publishedAt: '1989-01-01',
    summary:
      'The original short-story conception of the Xeelee Sequence, later expanded into the 1991 novel of the same name.',
    seriesOrder: 10,
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

const pad3 = (value) => String(value).padStart(3, '0');

function normalizeText(value) {
  return value.replace(/[\u00a0\s]+/g, ' ').trim();
}

function normalizeZipPath(value) {
  const withoutFragment = value.split('#', 1)[0].replaceAll('\\', '/');
  try {
    return posix.normalize(decodeURIComponent(withoutFragment));
  } catch {
    return posix.normalize(withoutFragment);
  }
}

function resolveZipPath(basePath, relativePath) {
  return normalizeZipPath(posix.join(posix.dirname(basePath), relativePath));
}

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function bookMetadata(book, chapterCount, translation) {
  return {
    slug: book.slug,
    private: true,
    title: book.title,
    subtitle: book.subtitle,
    author,
    category: 'works',
    groupSlug,
    groupTitle,
    groupType: 'series',
    groupOrder,
    seriesOrder: book.seriesOrder,
    language,
    editionLabel: `User-supplied English ${book.format.toUpperCase()} text`,
    alternateEditionSlug: translation?.bookSlug,
    alternateEditionLabel: translation ? '中文试译' : undefined,
    publishedAt: book.publishedAt,
    summary: book.summary,
    sourceUrl,
    sourceName: `Local file: ${book.filename}`,
    rightsNotice: privateRightsNotice,
    cover: null,
    chapterCount,
  };
}

async function translationFor(book) {
  const bookSlug = `${book.slug}-zh`;
  const translationRoot = join(repositoryRoot, 'src/content/books', bookSlug);
  try {
    await readFile(join(translationRoot, 'book.md'), 'utf8');
    const chapterFiles = await readdir(join(translationRoot, 'chapters'));
    const parallelSlugs = new Map(
      chapterFiles
        .filter((filename) => /^\d{3}-.+-zh\.md$/.test(filename))
        .map((filename) => {
          const translationSlug = filename.replace(/^\d{3}-/, '').replace(/\.md$/, '');
          return [translationSlug.replace(/-zh$/, ''), translationSlug];
        }),
    );
    return parallelSlugs.size ? { bookSlug, parallelSlugs } : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function chapterUnitType(title) {
  if (/^(acknowledg|dedication|foreword|preface|prologue)/i.test(title)) return 'preface';
  if (/^(afterword|author('|’)s note|timeline|footnotes)/i.test(title)) return 'supplement';
  return 'chapter';
}

function baseSlugForTitle(title, index) {
  const chapter = title.match(/^(?:chapter\s+)?(\d+)$/i);
  if (chapter) return `chapter-${String(Number(chapter[1])).padStart(2, '0')}`;
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || `section-${pad3(index)}`;
}

function assignSlugs(units, bookSlug) {
  const counts = new Map();
  for (const [index, unit] of units.entries()) {
    const localBase = baseSlugForTitle(unit.title, index + 1);
    const base = `${bookSlug}-${localBase}`;
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    unit.slug = count === 1 ? base : `${base}-${count}`;
  }
}

function markdownText(value) {
  return normalizeText(
    value
      .replace(/^#{1,6}\s+/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\*\*(.*)\*\*$/g, '$1')
      .replace(/^_(.*)_$/g, '$1'),
  );
}

function stripLeadingTitle(markdown, title) {
  const blocks = markdown.split(/\n{2,}/);
  if (
    blocks.length &&
    markdownText(blocks[0]).toLowerCase() === normalizeText(title).toLowerCase()
  ) {
    blocks.shift();
  }
  return blocks.join('\n\n').trim();
}

function removePromotionalElements(document, root) {
  const promotion = /^(?:OceanofPDF\.com|PDFDrive(?:\.com)?)$/i;
  root.find('a[href]').each((_, element) => {
    const anchor = document(element);
    if (/oceanofpdf|pdfdrive/i.test(anchor.attr('href') || '')) anchor.remove();
  });
  root.find('*').each((_, element) => {
    const current = document(element);
    if (current.children().length === 0 && promotion.test(normalizeText(current.text()))) {
      current.remove();
    }
  });
}

function cleanEpubHtml(rawHtml) {
  const document = loadHtml(rawHtml, { xmlMode: false });
  const root = document('body').first();
  if (!root.length) return { html: '', text: '' };
  root.find('script, style, nav, img, svg').remove();
  removePromotionalElements(document, root);
  root.find('[hidden], [aria-hidden="true"]').remove();
  return { html: root.html() || '', text: normalizeText(root.text()) };
}

function titleFromHtml(html, fallback) {
  const document = loadHtml(`<main>${html}</main>`, { xmlMode: false });
  const heading = normalizeText(document('h1, h2, h3, h4, h5, h6').first().text());
  if (heading) return heading;
  const firstBlock = document('p, div')
    .toArray()
    .map((element) => normalizeText(document(element).clone().children().remove().end().text()))
    .find((text) => text && text.length <= 100 && !/[.!?]$/.test(text));
  return firstBlock || fallback;
}

function isExcludedEpubUnit(book, title, sourcePath, text) {
  if (book.excludedTitles?.has(title)) return true;
  if (
    /^(cover|title|title page|copyright|contents|about the author|jacket blurb)$/i.test(title) ||
    /^xeelee:\s+redemption$/i.test(title)
  ) {
    return true;
  }
  if (/^(also by|previous publications)/i.test(title)) return true;
  if (/titlepage\.(?:x?html?|htm)$/i.test(sourcePath)) return true;
  if (/^(?:table of )?contents/i.test(text) && text.length < 8_000) return true;
  return false;
}

function epubHtmlToMarkdown(rawHtml, title, bookSlug, sourcePath, sourceSlugs) {
  const document = loadHtml(`<main id="book-unit">${rawHtml}</main>`, { xmlMode: false });
  const root = document('#book-unit');
  root.find('script, style, nav, img, svg').remove();
  removePromotionalElements(document, root);
  root.find('a[href]').each((_, element) => {
    const anchor = document(element);
    const href = anchor.attr('href') || '';
    if (!href || href.startsWith('#') || /^[a-z]+:/i.test(href)) return;
    const [target, fragment] = href.split('#', 2);
    const targetPath = resolveZipPath(sourcePath, target);
    const targetSlug = sourceSlugs.get(targetPath);
    if (targetSlug) {
      anchor.attr('href', `/books/${bookSlug}/${targetSlug}/${fragment ? `#${fragment}` : ''}`);
    } else {
      anchor.replaceWith(anchor.text());
    }
  });
  root.find('*').each((_, element) => {
    const current = document(element);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (current.is('a') && attribute === 'href') continue;
      current.removeAttr(attribute);
    }
  });

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  turndown.keep(['sub', 'sup']);
  const markdown = turndown
    .turndown(root.html() || '')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s*(?:OceanofPDF\.com|PDFDrive(?:\.com)?)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripLeadingTitle(markdown, title);
}

function parseEpubPackage(entries) {
  const containerBytes = entries['META-INF/container.xml'];
  if (!containerBytes) throw new Error('EPUB has no META-INF/container.xml');
  const container = loadHtml(textDecoder.decode(containerBytes), { xmlMode: true });
  const opfPath = normalizeZipPath(container('rootfile').attr('full-path') || '');
  if (!opfPath || !entries[opfPath]) throw new Error(`EPUB package not found: ${opfPath}`);
  const packageDocument = loadHtml(textDecoder.decode(entries[opfPath]), { xmlMode: true });
  const manifest = new Map();
  packageDocument('manifest > item').each((_, element) => {
    const item = packageDocument(element);
    const id = item.attr('id');
    const href = item.attr('href');
    if (id && href) {
      manifest.set(id, {
        path: resolveZipPath(opfPath, href),
        mediaType: item.attr('media-type') || '',
      });
    }
  });
  const spine = packageDocument('spine > itemref')
    .toArray()
    .map((element) => manifest.get(packageDocument(element).attr('idref'))?.path)
    .filter(Boolean);
  const navigation = [...manifest.values()].find(
    (item) => item.mediaType === 'application/x-dtbncx+xml' || item.path.endsWith('.ncx'),
  );
  const labels = new Map();
  if (navigation && entries[navigation.path]) {
    const ncx = loadHtml(textDecoder.decode(entries[navigation.path]), { xmlMode: true });
    ncx('navPoint').each((_, element) => {
      const point = ncx(element);
      const label = normalizeText(point.children('navLabel').children('text').text());
      const source = point.children('content').attr('src');
      if (!label || !source) return;
      const path = resolveZipPath(navigation.path, source);
      if (!labels.has(path)) labels.set(path, label);
    });
  }
  return { opfPath, spine, labels };
}

async function extractEpub(book, inputPath) {
  const entries = unzipSync(new Uint8Array(await readFile(inputPath)));
  const { opfPath, spine, labels } = parseEpubPackage(entries);
  if (!spine.length) throw new Error(`${book.filename}: EPUB spine is empty`);

  const rawUnits = [];
  const skipped = [];
  for (const [index, sourcePath] of spine.entries()) {
    const bytes = entries[sourcePath];
    if (!bytes) throw new Error(`${book.filename}: missing spine entry ${sourcePath}`);
    const cleaned = cleanEpubHtml(textDecoder.decode(bytes));
    const navigationTitle = labels.get(sourcePath);
    const configuredTitle = book.titleOverrides?.[sourcePath];
    const title = normalizeText(
      configuredTitle ||
        (navigationTitle && navigationTitle.toLowerCase() !== 'start'
          ? navigationTitle
          : titleFromHtml(cleaned.html, `Section ${index + 1}`)),
    );
    if (!cleaned.text) {
      skipped.push({ sourcePath, reason: 'empty' });
      continue;
    }
    if (isExcludedEpubUnit(book, title, sourcePath, cleaned.text)) {
      skipped.push({ sourcePath, title, reason: 'front-or-back-matter' });
      continue;
    }
    rawUnits.push({
      title,
      sourcePath,
      html: cleaned.html,
      hasNavigationTitle: Boolean(
        configuredTitle || (navigationTitle && navigationTitle.toLowerCase() !== 'start'),
      ),
    });
  }

  const units = [];
  let volumeNumber = 0;
  let volumeTitle;
  let volumeUnitNumber = 0;
  for (const rawUnit of rawUnits) {
    const preview = epubHtmlToMarkdown(
      rawUnit.html,
      rawUnit.title,
      book.slug,
      rawUnit.sourcePath,
      new Map(),
    );
    const startsNamedSection = book.sectionTitles?.has(rawUnit.title);
    const startsVolume = startsNamedSection || book.volumePattern?.test(rawUnit.title);
    if (startsVolume) {
      volumeNumber += 1;
      volumeTitle = rawUnit.title;
      volumeUnitNumber = 0;
    }
    if (startsNamedSection && markdownText(preview).length < 120) {
      skipped.push({
        sourcePath: rawUnit.sourcePath,
        title: rawUnit.title,
        reason: 'section-divider',
      });
      continue;
    }
    if (!preview) {
      skipped.push({ sourcePath: rawUnit.sourcePath, title: rawUnit.title, reason: 'title-only' });
      continue;
    }
    const title =
      book.useVolumeTitleForUnnavigated && !rawUnit.hasNavigationTitle && volumeTitle
        ? volumeUnitNumber === 0
          ? volumeTitle
          : `${volumeTitle} ${volumeUnitNumber + 1}`
        : rawUnit.title;
    volumeUnitNumber += 1;
    units.push({
      ...rawUnit,
      title,
      ...(volumeTitle ? { volumeNumber, volumeTitle, volumeUnitNumber } : {}),
    });
  }
  assignSlugs(units, book.slug);
  const sourceSlugs = new Map(units.map((unit) => [unit.sourcePath, unit.slug]));
  for (const unit of units) {
    unit.markdown = epubHtmlToMarkdown(
      unit.html,
      unit.title,
      book.slug,
      unit.sourcePath,
      sourceSlugs,
    );
    delete unit.html;
  }
  return { units, skipped, packagePath: opfPath, spineEntries: spine.length };
}

function pdfParagraphs(value) {
  return value
    .split(/\n\s*\n/)
    .map((block) =>
      normalizeText(block)
        .replace(/([A-Za-z])-\s+([a-z])/g, '$1-$2')
        .replace(/—\s+/g, '—')
        .replace(/^\*\*\*$/, '* * *'),
    )
    .filter(Boolean)
    .join('\n\n');
}

async function extractTimelikeInfinity(book, inputPath) {
  let stdout;
  try {
    ({ stdout } = await execFile('pdftotext', ['-layout', inputPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`Unable to extract ${book.filename}; pdftotext is required: ${error.message}`);
  }
  const pages = stdout.split('\f');
  const cleanedPages = pages.map((page) => {
    const lines = page.replaceAll('\r', '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (normalizeText(lines[0] || '') === book.title) lines.shift();
    return lines
      .filter((line) => !/^file:\/\//.test(line.trim()))
      .join('\n')
      .trim();
  });
  const lines = cleanedPages.join('\n').split('\n');
  const headings = [];
  for (const [index, line] of lines.entries()) {
    const match = line.trim().match(/^Chapter (\d+)$/);
    if (match) headings.push({ number: Number(match[1]), index });
  }
  const distinctHeadings = headings.filter(
    (heading, index) => heading.number === index + 1 && heading.number <= 16,
  );
  if (distinctHeadings.length !== 16) {
    throw new Error(
      `${book.filename}: expected 16 chapter headings, found ${distinctHeadings.length}`,
    );
  }
  const aboutAuthorIndex = lines.findIndex(
    (line, index) => index > distinctHeadings.at(-1).index && line.trim() === 'About the Author',
  );
  const units = [
    {
      title: 'Dedication',
      slug: `${book.slug}-dedication`,
      sourcePath: book.filename,
      markdown: 'To my niece, Jessica Bourg',
    },
  ];
  for (const [index, heading] of distinctHeadings.entries()) {
    const end = distinctHeadings[index + 1]?.index || aboutAuthorIndex;
    if (end <= heading.index)
      throw new Error(`${book.filename}: invalid Chapter ${heading.number}`);
    units.push({
      title: `Chapter ${heading.number}`,
      slug: `${book.slug}-chapter-${String(heading.number).padStart(2, '0')}`,
      sourcePath: book.filename,
      markdown: pdfParagraphs(lines.slice(heading.index + 1, end).join('\n')),
    });
  }
  return {
    units,
    skipped: [{ title: 'About the Author', reason: 'back-matter' }],
    pages: pages.filter((page) => page.trim()).length,
  };
}

function applyProofreadingCorrections(book, extraction) {
  for (const unit of extraction.units) {
    unit.markdown = unit.markdown.replace(/(?<=\p{L})\\-(?=\p{L})/gu, '-');
  }

  for (const correction of PROOFREADING_CORRECTIONS[book.slug] || []) {
    const expected = correction.expected ?? 1;
    const occurrences = extraction.units.reduce(
      (count, unit) => count + unit.markdown.split(correction.from).length - 1,
      0,
    );
    if (occurrences !== expected) {
      throw new Error(
        `${book.filename}: proofreading correction ${JSON.stringify(correction.from)} matched ${occurrences} times; expected ${expected}`,
      );
    }
    for (const unit of extraction.units) {
      unit.markdown = unit.markdown.replaceAll(correction.from, correction.to);
    }
  }
}

function validateExtraction(book, extraction) {
  const characters = extraction.units.reduce((total, unit) => total + unit.markdown.length, 0);
  const empty = extraction.units.filter((unit) => !unit.markdown.trim());
  const duplicateSlugs = extraction.units
    .map((unit) => unit.slug)
    .filter((slug, index, slugs) => slugs.indexOf(slug) !== index);
  const invalidUnits = extraction.units.filter(
    (unit) =>
      /\uFFFD/.test(unit.markdown) ||
      /(?:OceanofPDF|PDFDrive|file:\/\/)/i.test(unit.markdown) ||
      /\]\((?![#/]|[a-z][a-z0-9+.-]*:)[^)]+\)/i.test(unit.markdown) ||
      /(?<=\p{L})\\-(?=\p{L})/u.test(unit.markdown),
  );
  if (invalidUnits.length) {
    throw new Error(
      `${book.filename}: failed text quality checks in: ${invalidUnits.map((unit) => unit.title).join(', ')}`,
    );
  }
  if (extraction.units.length < book.minimumChapters) {
    throw new Error(
      `${book.filename}: extracted ${extraction.units.length} units, expected at least ${book.minimumChapters}`,
    );
  }
  if (characters < book.minimumCharacters) {
    throw new Error(
      `${book.filename}: extracted ${characters} characters, expected at least ${book.minimumCharacters}`,
    );
  }
  if (empty.length) throw new Error(`${book.filename}: extracted empty reading units`);
  if (duplicateSlugs.length) {
    throw new Error(`${book.filename}: duplicate chapter slugs: ${duplicateSlugs.join(', ')}`);
  }
  return characters;
}

async function writeLocalBook(workspace, book, extraction, translation) {
  const outputRoot = join(workspace, book.slug);
  const chapterDirectory = join(outputRoot, 'chapters');
  await mkdir(chapterDirectory, { recursive: true });
  for (const [index, unit] of extraction.units.entries()) {
    const chapterNumber = index + 1;
    const metadata = {
      bookSlug: book.slug,
      chapterNumber,
      slug: unit.slug,
      title: unit.title,
      sourcePath: `${book.filename}${unit.sourcePath === book.filename ? '' : `#${unit.sourcePath}`}`,
      volumeNumber: unit.volumeNumber,
      volumeTitle: unit.volumeTitle,
      volumeUnitNumber: unit.volumeUnitNumber,
      unitType: chapterUnitType(unit.title),
      parallelSlug: translation?.parallelSlugs.get(unit.slug),
    };
    await writeFile(
      join(chapterDirectory, `${pad3(chapterNumber)}-${unit.slug}.md`),
      `---\n${frontMatter(metadata)}\n---\n\n${unit.markdown}\n`,
    );
  }
  await writeFile(
    join(outputRoot, 'book.md'),
    `---\n${frontMatter(bookMetadata(book, extraction.units.length, translation))}\n---\n`,
  );
  const report = {
    input: book.filename,
    format: book.format,
    title: book.title,
    private: true,
    generatedChapters: extraction.units.length,
    characters: extraction.characters,
    ...(extraction.packagePath ? { packagePath: extraction.packagePath } : {}),
    ...(extraction.spineEntries ? { spineEntries: extraction.spineEntries } : {}),
    ...(extraction.pages ? { pages: extraction.pages } : {}),
    skipped: extraction.skipped,
    chapters: extraction.units.map((unit, index) => ({
      chapterNumber: index + 1,
      slug: unit.slug,
      title: unit.title,
      sourcePath: unit.sourcePath,
      characters: unit.markdown.length,
      ...(unit.volumeNumber
        ? {
            volumeNumber: unit.volumeNumber,
            volumeTitle: unit.volumeTitle,
            volumeUnitNumber: unit.volumeUnitNumber,
          }
        : {}),
    })),
  };
  await writeFile(join(outputRoot, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

async function importLocalBooks(inputDirectory) {
  const workspace = await mkdtemp(join(repositoryRoot, '.xeelee-import-'));
  try {
    const imported = [];
    const chapterSlugs = new Set();
    for (const book of LOCAL_BOOKS) {
      const inputPath = join(inputDirectory, book.filename);
      console.log(`Extracting ${book.title} from ${inputPath}`);
      const extraction =
        book.format === 'epub'
          ? await extractEpub(book, inputPath)
          : await extractTimelikeInfinity(book, inputPath);
      applyProofreadingCorrections(book, extraction);
      for (const unit of extraction.units) {
        if (chapterSlugs.has(unit.slug)) {
          throw new Error(`${book.filename}: globally duplicate chapter slug: ${unit.slug}`);
        }
        chapterSlugs.add(unit.slug);
      }
      extraction.characters = validateExtraction(book, extraction);
      const translation = await translationFor(book);
      await writeLocalBook(workspace, book, extraction, translation);
      imported.push({
        slug: book.slug,
        title: book.title,
        chapters: extraction.units.length,
        characters: extraction.characters,
      });
      console.log(
        `  ${extraction.units.length} reading units, ${extraction.characters.toLocaleString('en')} characters`,
      );
    }
    for (const item of imported) {
      const target = join(repositoryRoot, 'src/content/books', item.slug);
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await rename(join(workspace, item.slug), target);
    }
    console.log(`Imported ${imported.length} private Xeelee books.`);
    console.log(
      'Skipped duplicate source: Xeelee An Omnibus (Raft, Timelike Infinity, Flux, Ring).azw3',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return textDecoder.decode(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((done) => setTimeout(done, 400 * attempt));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

function extractFreeStory(source, html) {
  const document = loadHtml(html);
  document('script, style, nav, noscript').remove();
  const paragraphs = document('body p')
    .toArray()
    .map((element) => normalizeText(document(element).text()))
    .filter(Boolean);
  const forewordIndex = paragraphs.indexOf(source.checks.forewordHeading);
  const storyStartIndex = paragraphs.findIndex((text) => text.startsWith(source.checks.storyStart));
  const storyEndIndex = paragraphs.findIndex(
    (text, index) => index >= storyStartIndex && text.includes(source.checks.storyEnd),
  );
  if (forewordIndex < 0 || storyStartIndex < 0 || storyEndIndex < storyStartIndex) {
    throw new Error(`${source.url}: source structure did not match the expected story boundaries`);
  }
  return [
    paragraphs
      .slice(forewordIndex + 1, storyStartIndex)
      .filter((text) => text !== source.title)
      .join('\n\n'),
    paragraphs.slice(storyStartIndex, storyEndIndex + 1).join('\n\n'),
  ];
}

async function importFreeStories() {
  const workspace = await mkdtemp(join(repositoryRoot, '.xeelee-import-'));
  try {
    for (const source of FREE_STORIES) {
      const bodies = extractFreeStory(source, await fetchText(source.url));
      const outputRoot = join(workspace, source.bookSlug);
      const chapterDirectory = join(outputRoot, 'chapters');
      await mkdir(chapterDirectory, { recursive: true });
      for (const [index, unit] of source.plan.entries()) {
        await writeFile(
          join(chapterDirectory, `${pad3(index + 1)}-${unit.slug}.md`),
          `---\n${frontMatter({
            bookSlug: source.bookSlug,
            chapterNumber: index + 1,
            slug: unit.slug,
            title: unit.title,
            unitType: unit.unitType,
            sourcePath: source.url,
          })}\n---\n\n${bodies[index]}\n`,
        );
      }
      await writeFile(
        join(outputRoot, 'book.md'),
        `---\n${frontMatter({
          slug: source.bookSlug,
          private: true,
          title: source.title,
          subtitle: source.subtitle,
          author,
          category: 'works',
          groupSlug,
          groupTitle,
          groupType: 'series',
          groupOrder,
          seriesOrder: source.seriesOrder,
          language,
          editionLabel: source.editionLabel,
          publishedAt: source.publishedAt,
          summary: source.summary,
          sourceUrl: source.url,
          sourceName: source.sourceName,
          rightsNotice: source.rightsNotice,
          cover: null,
          chapterCount: bodies.length,
        })}\n---\n`,
      );
      const report = {
        sourceUrl: source.url,
        title: source.title,
        language,
        generatedChapters: bodies.length,
        characters: bodies.reduce((total, body) => total + body.length, 0),
        chapters: source.plan.map((unit, index) => ({
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
      const target = join(repositoryRoot, 'src/content/books', source.bookSlug);
      await rm(target, { recursive: true, force: true });
      await rename(outputRoot, target);
      console.log(`Imported private short story ${source.bookSlug}.`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--free')) {
    await importFreeStories();
    return;
  }
  const directoryIndex = args.indexOf('--from-dir');
  const inputDirectory = resolve(
    repositoryRoot,
    directoryIndex >= 0 ? args[directoryIndex + 1] || '' : 'tmp',
  );
  await importLocalBooks(inputDirectory);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

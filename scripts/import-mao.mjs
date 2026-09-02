// @ts-nocheck
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRevision = 'f23ff5c48d976561f888c6ce8c594725d5670e38';
const sourceRepository = 'https://github.com/weiyinfu/MaoZeDongAnthology';
const sourceArchiveUrl = `https://codeload.github.com/weiyinfu/MaoZeDongAnthology/tar.gz/${sourceRevision}`;
const sourceBlobRoot = `${sourceRepository}/blob/${sourceRevision}`;
const userAgent = 'Tursom-Log-mao-importer/1.0';
const bookSlug = 'mao-selected-works';
const parenthesizedFootnoteNumbers = [...'⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇'];

const sourceFootnoteCorrections = new Map([
  [
    '007-必须注意经济工作.md',
    [['跟着查田运动的开展而开展的检举运动，', '跟着查田运动的开展而开展的检举运动⑷，']],
  ],
  [
    '035-和中央社、扫荡报、新民报三记者的谈话.md',
    [['和注〔6〕。〔9〕见', '和注〔6〕。\n　　〔9〕见']],
  ],
  [
    '195-关于中华人民共和国宪法草案.md',
    [['到民国元年的《中华民国临时约法》[1]', '到民国元年的《中华民国临时约法》[2]']],
  ],
  ['206-《中国农村的社会主义高潮》的按语.md', [["所谓“倒宣传”'1'", '所谓“倒宣传”[1]']]],
]);

const volumes = [
  { number: 1, title: '第一卷 国内革命战争时期', firstSourceIndex: 0, lastSourceIndex: 17 },
  { number: 2, title: '第二卷 抗日战争时期（上）', firstSourceIndex: 18, lastSourceIndex: 57 },
  { number: 3, title: '第三卷 抗日战争时期（下）', firstSourceIndex: 58, lastSourceIndex: 88 },
  {
    number: 4,
    title: '第四卷 第三次国内革命战争时期',
    firstSourceIndex: 89,
    lastSourceIndex: 158,
  },
  { number: 5, title: '第五卷 中国人民站起来了', firstSourceIndex: 159, lastSourceIndex: 228 },
];

function frontMatter(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
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

function parseSourceIndex(filename) {
  const match = filename.match(/^(\d{3})-.+\.md$/u);
  return match ? Number(match[1]) : null;
}

function sourceUrl(filename) {
  return `${sourceBlobRoot}/src/${encodeURIComponent(filename)}`;
}

function applySourceFootnoteCorrections(markdown, filename) {
  let corrected = markdown;
  for (const [from, to] of sourceFootnoteCorrections.get(filename) ?? []) {
    if (!corrected.includes(from)) throw new Error(`${filename} no longer contains ${from}`);
    corrected = corrected.replace(from, to);
  }
  return corrected;
}

function extractTitleFootnote(title) {
  const markerIndex = [...title].findIndex((character) =>
    parenthesizedFootnoteNumbers.includes(character),
  );
  if (markerIndex === -1) return { title };

  const characters = [...title];
  const marker = characters[markerIndex];
  characters.splice(markerIndex, 1);
  return {
    title: characters.join(''),
    titleFootnote: {
      number: parenthesizedFootnoteNumbers.indexOf(marker) + 1,
      offset: markerIndex,
    },
  };
}

function noteNumber(line) {
  const match = line.match(/^\s*(?:〔(\d+)[〕）]|\[(\d+)\]|（(\d+)）)/u);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : null;
}

function convertUnlinkedFootnoteMarkers(body) {
  if (!/[⑴-⒇]/u.test(body)) return body;
  let converted = body;
  parenthesizedFootnoteNumbers.forEach((marker, index) => {
    converted = converted
      .split(marker)
      .join(`<sup class="source-footnote-marker" aria-label="注 ${index + 1}">${index + 1}</sup>`);
  });
  return converted.replace(
    /[（(](2[1-9]|[3-9]\d)[）)]/gu,
    (_, number) => `<sup class="source-footnote-marker" aria-label="注 ${number}">${number}</sup>`,
  );
}

function replaceFootnoteReferences(body, noteNumbers, volumeNumber, titleFootnote, filename) {
  let converted = body;
  const referenceCounts = new Map();

  for (const number of noteNumbers) {
    const markers =
      volumeNumber <= 4
        ? number <= parenthesizedFootnoteNumbers.length
          ? [parenthesizedFootnoteNumbers[number - 1]]
          : [`（${number}）`, `(${number})`, `〔${number}〕`]
        : [`[${number}]`];
    let count = 0;
    for (const marker of markers) {
      const occurrences = converted.split(marker).length - 1;
      if (!occurrences) continue;
      converted = converted.split(marker).join(`[^${number}]`);
      count += occurrences;
    }
    if (titleFootnote?.number === number) count += 1;
    referenceCounts.set(number, count);
  }

  const missing = [...referenceCounts].filter(([, count]) => count === 0).map(([number]) => number);
  if (missing.length) {
    throw new Error(`${filename} has notes without references: ${missing.join(', ')}`);
  }
  return converted;
}

function convertFootnotes(body, volumeNumber, titleFootnote, filename) {
  const lines = body.split('\n');
  const separatorIndex = lines.findIndex((line) => /^\s*-{5,}\s*$/u.test(line));
  if (separatorIndex === -1) return convertUnlinkedFootnoteMarkers(body);

  const headingIndex = lines.findIndex(
    (line, index) => index > separatorIndex && /^\s*注\s*释\s*$/u.test(line),
  );
  if (headingIndex === -1) return convertUnlinkedFootnoteMarkers(body);

  const notes = lines.slice(headingIndex + 1);
  const noteNumbers = notes.map(noteNumber).filter((number) => number !== null);
  if (!noteNumbers.length) return convertUnlinkedFootnoteMarkers(body);
  if (new Set(noteNumbers).size !== noteNumbers.length) {
    throw new Error(`${filename} contains duplicate note definitions`);
  }

  const main = replaceFootnoteReferences(
    lines.slice(0, separatorIndex).join('\n').trimEnd(),
    noteNumbers,
    volumeNumber,
    titleFootnote,
    filename,
  );
  const definitions = convertUnlinkedFootnoteMarkers(
    notes
      .map((line) => {
        const number = noteNumber(line);
        return number === null
          ? line
          : line.replace(/^\s*(?:〔\d+[〕）]|\[\d+\]|（\d+）)\s*/u, `[^${number}]: `);
      })
      .join('\n')
      .trim(),
  );
  const titlePlaceholder = titleFootnote
    ? `<span data-title-footnote-placeholder="${titleFootnote.number}"></span>[^${titleFootnote.number}]\n\n`
    : '';

  return `${titlePlaceholder}${main}\n\n${definitions}\n`;
}

function parseArticle(markdown, filename, volumeNumber) {
  const normalized = applySourceFootnoteCorrections(markdown, filename)
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const firstContentLine = lines.findIndex((line) => line.trim());
  const titleMatch = lines[firstContentLine]?.match(/^#\s+(.+?)\s*$/u);
  if (!titleMatch) throw new Error(`${filename} does not start with a level-one title`);

  const parsedTitle = extractTitleFootnote(titleMatch[1].trim());
  const body = lines
    .slice(firstContentLine + 1)
    .join('\n')
    .trim();
  if (!body) throw new Error(`${filename} produced no text`);
  return {
    ...parsedTitle,
    body: convertFootnotes(`${body}\n`, volumeNumber, parsedTitle.titleFootnote, filename),
  };
}

function volumeForSourceIndex(sourceIndex) {
  const volume = volumes.find(
    ({ firstSourceIndex, lastSourceIndex }) =>
      sourceIndex >= firstSourceIndex && sourceIndex <= lastSourceIndex,
  );
  if (!volume) throw new Error(`Source article ${sourceIndex} is not assigned to a volume`);
  return volume;
}

async function writeBook(sourceDirectory, outputRoot) {
  const sourceFiles = (await readdir(sourceDirectory))
    .map((filename) => ({ filename, sourceIndex: parseSourceIndex(filename) }))
    .filter((entry) => entry.sourceIndex !== null)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
  const expectedArticleCount = volumes.at(-1).lastSourceIndex + 1;

  if (sourceFiles.length !== expectedArticleCount) {
    throw new Error(
      `Expected ${expectedArticleCount} source articles, found ${sourceFiles.length}`,
    );
  }
  sourceFiles.forEach(({ filename, sourceIndex }, index) => {
    if (sourceIndex !== index)
      throw new Error(`Expected source article ${index}, found ${filename}`);
  });

  const bookDirectory = join(outputRoot, bookSlug);
  const chapterDirectory = join(bookDirectory, 'chapters');
  await mkdir(chapterDirectory, { recursive: true });
  const reports = [];

  for (const { filename, sourceIndex } of sourceFiles) {
    const volume = volumeForSourceIndex(sourceIndex);
    const volumeUnitNumber = sourceIndex - volume.firstSourceIndex + 1;
    const chapterNumber = sourceIndex + 1;
    const slug = `volume-${String(volume.number).padStart(2, '0')}-article-${String(
      volumeUnitNumber,
    ).padStart(3, '0')}`;
    const { title, titleFootnote, body } = parseArticle(
      await readFile(join(sourceDirectory, filename), 'utf8'),
      filename,
      volume.number,
    );

    await writeFile(
      join(chapterDirectory, `${String(chapterNumber).padStart(3, '0')}-${slug}.md`),
      `---\n${frontMatter({
        bookSlug,
        chapterNumber,
        slug,
        title,
        titleFootnote,
        sourcePath: sourceUrl(filename),
        volumeNumber: volume.number,
        volumeTitle: volume.title,
        volumeUnitNumber,
        unitType: 'chapter',
      })}\n---\n\n${body}`,
    );
    reports.push({
      chapterNumber,
      slug,
      title,
      volumeNumber: volume.number,
      sourcePath: sourceUrl(filename),
      characters: body.length,
    });
  }

  await writeFile(
    join(bookDirectory, 'book.md'),
    `---\n${frontMatter({
      slug: bookSlug,
      title: '毛泽东选集',
      subtitle: '第一至第五卷',
      author: '毛泽东',
      language: 'zh-CN',
      editionLabel: '五卷本电子整理版',
      summary: '收录《毛泽东选集》第一至第五卷，共二百二十九篇文章，按各卷原有次序编排。',
      sourceUrl: `${sourceRepository}/tree/${sourceRevision}`,
      sourceName: 'MaoZeDongAnthology（固定版本）',
      rightsNotice:
        '正文据公开电子文本整理；来源项目未声明许可证，原作及电子文本的转载范围需按所在地法律核验，公开部署前请另行确认授权',
      cover: null,
      volumeCount: volumes.length,
      chapterCount: reports.length,
    })}\n---\n`,
  );
  await writeFile(
    join(bookDirectory, 'import-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceRevision,
        title: '毛泽东选集',
        language: 'zh-CN',
        volumes: volumes.length,
        generatedChapters: reports.length,
        characters: reports.reduce((total, chapter) => total + chapter.characters, 0),
        chapters: reports,
      },
      null,
      2,
    )}\n`,
  );

  return reports.length;
}

async function main() {
  const workspace = await mkdtemp(join(repositoryRoot, '.mao-import-'));
  try {
    const archivePath = join(workspace, 'source.tar.gz');
    const sourceDirectory = join(workspace, 'source');
    const contentOutputRoot = join(workspace, 'content');
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(contentOutputRoot, { recursive: true });

    console.log('Downloading pinned MaoZeDongAnthology source archive…');
    await writeFile(archivePath, await fetchBuffer(sourceArchiveUrl));
    await execFileAsync('tar', ['xzf', archivePath, '-C', sourceDirectory, '--strip-components=1']);

    console.log('Converting five volumes…');
    const articleCount = await writeBook(join(sourceDirectory, 'src'), contentOutputRoot);
    const contentTarget = join(repositoryRoot, 'src/content/books', bookSlug);
    await rm(contentTarget, { recursive: true, force: true });
    await mkdir(dirname(contentTarget), { recursive: true });
    await rename(join(contentOutputRoot, bookSlug), contentTarget);

    console.log(`Imported ${articleCount} reading units.`);
    console.log(`Content: ${relative(repositoryRoot, contentTarget)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

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

function parseArticle(markdown, filename) {
  const normalized = markdown.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const firstContentLine = lines.findIndex((line) => line.trim());
  const titleMatch = lines[firstContentLine]?.match(/^#\s+(.+?)\s*$/u);
  if (!titleMatch) throw new Error(`${filename} does not start with a level-one title`);

  const body = lines
    .slice(firstContentLine + 1)
    .join('\n')
    .trim();
  if (!body) throw new Error(`${filename} produced no text`);
  return { title: titleMatch[1].trim(), body: `${body}\n` };
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
    const { title, body } = parseArticle(
      await readFile(join(sourceDirectory, filename), 'utf8'),
      filename,
    );

    await writeFile(
      join(chapterDirectory, `${String(chapterNumber).padStart(3, '0')}-${slug}.md`),
      `---\n${frontMatter({
        bookSlug,
        chapterNumber,
        slug,
        title,
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

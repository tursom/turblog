// @ts-nocheck
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeNovel } from './crawl-syosetu.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
// CommonMark allows escaping every ASCII punctuation character, not just the first line.
const escape = (text) =>
  text
    .replace(
      /[!-/:-@[-`{-~]/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? `\\${character}`,
    )
    .replace(/^[ \t]+/gm, (indent) => indent.replace(/ /g, '&#32;').replace(/\t/g, '&#9;'));
const frontMatter = (data) =>
  `---\n${Object.entries(data)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n`;

async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Invalid JSON in translated book input or import receipt.');
    throw error;
  }
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Expected a regular file, not a symlink.');
  return path;
}

async function loadTranslation(input) {
  const directory = await realpath(resolve(input));
  const manifest = await json(await regularFile(join(directory, 'manifest.json')));
  if (
    manifest?.version !== 1 ||
    manifest.complete !== true ||
    manifest.machineTranslated !== true ||
    !Array.isArray(manifest.chapters) ||
    !manifest.chapters.length ||
    !['title', 'summary', 'author', 'language', 'sourceUrl'].every(
      (key) => typeof manifest[key] === 'string',
    ) ||
    !manifest.title.trim() ||
    !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(manifest.language)
  ) {
    throw new Error('Expected a complete version-1 machine-translated book.');
  }
  const novel = normalizeNovel(manifest.sourceUrl);
  if (novel.url !== manifest.sourceUrl)
    throw new Error('Translation source must be a canonical novel URL.');
  const language = manifest.language.toLowerCase();
  const slug = `syosetu-${novel.ncode}-${language}`;
  if ((await realpath(join(directory, 'chapters'))) !== join(directory, 'chapters')) {
    throw new Error('Translated chapters directory must not be a symlink.');
  }
  const chapters = [];
  const ids = new Set();
  for (const entry of manifest.chapters) {
    if (
      !entry ||
      !['file', 'title', 'group', 'sourceUrl'].every((key) => typeof entry[key] === 'string') ||
      !entry.title.trim()
    ) {
      throw new Error('Invalid translated chapter entry.');
    }
    const match = entry.sourceUrl.match(
      new RegExp(`^https://novel18\\.syosetu\\.com/${novel.ncode}/([1-9]\\d*/)?$`),
    );
    if (!match) throw new Error('Chapter source is outside the translated novel.');
    const id = match[1] ? match[1].slice(0, -1) : 'oneshot';
    if (
      entry.file !== `chapters/${id}.json` ||
      ids.has(id) ||
      (id === 'oneshot' && manifest.chapters.length !== 1)
    ) {
      throw new Error('Unsafe, duplicate, or inconsistent translated chapter path.');
    }
    ids.add(id);
    const chapter = await json(await regularFile(join(directory, entry.file)));
    if (
      chapter?.version !== 1 ||
      chapter.machineTranslated !== true ||
      chapter.sourceUrl !== entry.sourceUrl ||
      chapter.title !== entry.title ||
      chapter.group !== entry.group ||
      !['body', 'preface', 'afterword'].every((key) => typeof chapter[key]?.text === 'string') ||
      !chapter.body.text.trim()
    ) {
      throw new Error(`Incomplete or inconsistent translated chapter ${id}.`);
    }
    chapters.push({ ...chapter, id });
  }
  return { manifest, chapters, slug };
}

function renderBook({ manifest, chapters, slug }) {
  const files = new Map();
  let volumeNumber = 0;
  let volumeUnitNumber = 0;
  let previousGroup = '';
  let grouped = false;
  for (const [index, chapter] of chapters.entries()) {
    // Once grouped, label any subsequent ungrouped run explicitly so ordering remains coherent.
    const group = chapter.group || (grouped ? '未分卷章节' : '');
    if (group && group !== previousGroup) {
      volumeNumber++;
      volumeUnitNumber = 0;
      previousGroup = group;
      grouped = true;
    }
    volumeUnitNumber++;
    const chapterSlug = chapter.id === 'oneshot' ? 'oneshot' : `episode-${chapter.id}`;
    const fields = {
      bookSlug: slug,
      chapterNumber: index + 1,
      slug: chapterSlug,
      title: chapter.title,
      sourcePath: chapter.sourceUrl,
      unitType: 'chapter',
      ...(group ? { volumeNumber, volumeTitle: group, volumeUnitNumber } : {}),
    };
    const sections = [];
    if (chapter.preface.text.trim())
      sections.push(`## 作者前言\n\n${escape(chapter.preface.text)}`);
    sections.push(escape(chapter.body.text));
    if (chapter.afterword.text.trim())
      sections.push(`## 作者后记\n\n${escape(chapter.afterword.text)}`);
    files.set(
      `chapters/${String(index + 1).padStart(4, '0')}-${chapterSlug}.md`,
      frontMatter(fields) + '\n' + sections.join('\n\n') + '\n',
    );
  }
  const fields = {
    slug,
    private: true,
    title: manifest.title,
    author: manifest.author.trim() || '作者未署名',
    category: 'works',
    groupSlug: slug,
    groupTitle: manifest.title,
    groupType: 'editions',
    groupOrder: 100,
    seriesOrder: 1,
    translator: '机器翻译（未经人工校对）',
    language: manifest.language,
    editionLabel: '非正式机器译本',
    summary: manifest.summary.trim() || `${manifest.title}的非正式机器译本，仅供授权私人阅读。`,
    sourceUrl: manifest.sourceUrl,
    sourceName: '小説家になろう（R18）',
    rightsNotice:
      '原作版权归作者及相关权利人所有。本机器译本仅供获授权的私人阅读；私有访问不代表取得翻译、转载或传播授权，未经许可不得公开传播。',
    cover: null,
    chapterCount: chapters.length,
    ...(volumeNumber ? { volumeCount: volumeNumber } : {}),
  };
  files.set('book.md', frontMatter(fields));
  return files;
}

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error('Existing imported book contains a symlink; refusing to replace it.');
    if (entry.isDirectory()) files.push(...(await walk(join(directory, entry.name), path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Existing imported book contains an unsupported file type.');
  }
  return files.sort();
}

async function checkExisting(directory, sourceUrl, language, slug) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Book destination must be a real directory, not a symlink.');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let receipt;
  try {
    receipt = await json(await regularFile(join(directory, 'import-receipt.json')));
  } catch {
    throw new Error('Destination already exists and is not owned by this importer.');
  }
  if (
    receipt?.version !== 1 ||
    receipt.generator !== 'syosetu-private-translation' ||
    receipt.sourceUrl !== sourceUrl ||
    receipt.language !== language ||
    receipt.slug !== slug ||
    !receipt.files ||
    typeof receipt.files !== 'object' ||
    Array.isArray(receipt.files)
  ) {
    throw new Error('Destination ownership does not match this translation.');
  }
  const actual = await walk(directory);
  const expected = [...Object.keys(receipt.files), 'import-receipt.json'].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Imported book has added or removed files; refusing to overwrite local edits.');
  for (const path of actual.filter((path) => path !== 'import-receipt.json')) {
    if (hash(await readFile(join(directory, path))) !== receipt.files[path]) {
      throw new Error('Imported book was edited locally; refusing to overwrite it.');
    }
  }
  return true;
}

export async function importTranslatedBook(
  input,
  { booksRoot = join(root, 'src/content/books'), dryRun = false, log = console.log } = {},
) {
  const translation = await loadTranslation(input);
  const { slug, manifest, chapters } = translation;
  const files = renderBook(translation);
  const destinationRoot = resolve(booksRoot);
  const directory = join(destinationRoot, slug);
  // Validate the whole input and existing ownership before creating or replacing book content.
  await checkExisting(directory, manifest.sourceUrl, manifest.language.toLowerCase(), slug);
  const result = {
    slug,
    directory,
    chapterCount: chapters.length,
    private: true,
    path: `/books/${slug}/`,
  };
  if (dryRun) {
    log(`Would import ${chapters.length} chapters as a private book: ${result.path}`);
    return result;
  }
  await mkdir(destinationRoot, { recursive: true });
  const lock = join(destinationRoot, `.${slug}.import-lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Import is locked. Another import may be running; inspect the lock before retrying.',
      );
    throw error;
  }
  let stage;
  let backedUp = false;
  const backup = join(lock, 'previous');
  try {
    const exists = await checkExisting(
      directory,
      manifest.sourceUrl,
      manifest.language.toLowerCase(),
      slug,
    );
    stage = await mkdtemp(join(destinationRoot, `.${slug}.import-`));
    await mkdir(join(stage, 'chapters'));
    for (const [path, content] of files)
      await writeFile(join(stage, path), content, { mode: 0o600 });
    const receipt = {
      version: 1,
      generator: 'syosetu-private-translation',
      slug,
      sourceUrl: manifest.sourceUrl,
      language: manifest.language.toLowerCase(),
      importedAt: new Date().toISOString(),
      files: Object.fromEntries([...files].map(([path, content]) => [path, hash(content)])),
    };
    await writeFile(join(stage, 'import-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    if (exists) {
      await rename(directory, backup);
      backedUp = true;
    }
    try {
      await rename(stage, directory);
      stage = undefined;
    } catch (error) {
      if (backedUp) {
        await rename(backup, directory);
        backedUp = false;
      }
      throw error;
    }
    backedUp = false;
    log(`Imported ${chapters.length} chapters as a private book: ${result.path}`);
    return result;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    // Preserve the previous book inside the lock if rollback itself failed.
    if (!backedUp) await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm import:translation <translation-directory> [--dry-run]

Import a completed translation as a PRIVATE blog book (private cannot be disabled).
Output: src/content/books/syosetu-<ncode>-<language>/
Existing importer-owned, unedited books can be updated; other content is never replaced.
No API calls, Git commits, pushes, builds or deployments are performed.
Generated books are ignored by Git; deploy through the authenticated Go service using a private build.`);
    return;
  }
  if (positionals.length !== 1)
    throw new Error('Provide exactly one completed translation directory.');
  await importTranslatedBook(positionals[0], { dryRun: values['dry-run'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Private import stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

// @ts-nocheck
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import TurndownService from 'turndown';
import { normalizeNovel } from './crawl-syosetu.mjs';
import { createTranslationProvider, translationQualityIssue } from './translation-providers.mjs';
import { importTranslatedBook } from './import-translated-book.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const markdown = new TurndownService();
const asMarkdown = (text) =>
  markdown.escape(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function splitText(text, maxChars = 2000) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1)
    throw new Error('Chunk size must be a positive integer.');
  const parts = [];
  let points = Array.from(text.trim());
  while (points.length) {
    let end = Math.min(maxChars, points.length);
    if (end < points.length) {
      // Prefer paragraph boundaries, then sentence/word boundaries; never split a surrogate pair.
      const candidate = points.slice(0, end).join('');
      const paragraph = candidate.lastIndexOf('\n\n');
      if (paragraph > 0) end = Array.from(candidate.slice(0, paragraph + 2)).length;
      else {
        for (let i = end - 1; i >= Math.floor(end / 2); i--) {
          if (/[\s。！？.!?]/u.test(points[i])) {
            end = i + 1;
            break;
          }
        }
      }
    }
    let piece = points.slice(0, end).join('');
    points = points.slice(end);
    while (points.length && /\s/u.test(points[0])) piece += points.shift();
    const separator = piece.match(/\s*$/u)[0];
    if (piece.trim())
      parts.push({ text: piece.trim(), separator: separator || (points.length ? '\n\n' : '') });
  }
  return parts;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function atomicJson(path, value) {
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}
async function atomicWrite(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadNovel(input) {
  const directory = await realpath(resolve(input));
  const manifest = await json(join(directory, 'manifest.json'));
  if (
    manifest?.version !== 1 ||
    manifest.complete !== true ||
    !Array.isArray(manifest.chapters) ||
    !manifest.chapters.length
  ) {
    throw new Error('Expected a complete version-1 crawler manifest; finish crawling first.');
  }
  const novel = normalizeNovel(manifest.url);
  if (
    manifest.ncode !== novel.ncode ||
    manifest.url !== novel.url ||
    !['title', 'author', 'summary'].every((key) => typeof manifest[key] === 'string') ||
    !manifest.title.trim()
  ) {
    throw new Error('Invalid source novel metadata.');
  }
  const ids = new Set();
  const chapters = [];
  for (const entry of manifest.chapters) {
    if (
      !entry ||
      typeof entry.url !== 'string' ||
      !['title', 'group', 'revision'].every((key) => typeof entry[key] === 'string')
    ) {
      throw new Error('Invalid chapter entry.');
    }
    const match = entry.url.match(
      new RegExp(`^https://novel18\\.syosetu\\.com/${novel.ncode}/([1-9]\\d*/)?$`),
    );
    if (!match) throw new Error('Source chapter URL is outside this novel.');
    const id = match[1] ? match[1].slice(0, -1) : 'oneshot';
    if (ids.has(id) || (id === 'oneshot' && manifest.chapters.length !== 1))
      throw new Error('Duplicate or mixed short-story chapters.');
    ids.add(id);
    const chapter = await json(join(directory, 'chapters', `${id}.json`));
    if (
      chapter?.version !== 1 ||
      chapter.url !== entry.url ||
      chapter.revision !== entry.revision ||
      !['body', 'preface', 'afterword'].every(
        (key) =>
          typeof chapter[key]?.text === 'string' && typeof chapter[key]?.markdown === 'string',
      ) ||
      !chapter.body.text.trim() ||
      chapter.checksum !== hash(JSON.stringify(chapter.body))
    ) {
      throw new Error(`Invalid or stale source chapter ${id}; run the crawler again.`);
    }
    chapters.push({ ...chapter, ...entry, id });
  }
  return { directory, manifest, chapters };
}

async function canonicalDestination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalDestination(dirname(path)), relative(dirname(path), path));
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../'));
}

async function cachedChunk(directory, key, sourceText, languages) {
  try {
    const cached = await json(join(directory, 'cache', `${key}.json`));
    if (
      cached?.version === 1 &&
      cached.key === key &&
      typeof cached.text === 'string' &&
      cached.checksum === hash(cached.text) &&
      translationQualityIssue(sourceText, cached.text, languages) === null
    )
      return cached;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

function validateConcurrency(concurrency) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Concurrency must be a positive integer between 1 and 32.');
  }
}

export async function translateNovel(
  input,
  {
    translator,
    output,
    maxChars = 2000,
    concurrency = 4,
    notes = false,
    refresh = false,
    dryRun = false,
    importBlog = false,
    log = console.log,
  } = {},
) {
  validateConcurrency(concurrency);
  if (!translator?.identity || typeof translator.translate !== 'function')
    throw new Error('A translation provider is required.');
  const target = translator.identity.target;
  if (typeof target !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(target))
    throw new Error('Invalid target language code.');
  splitText('', maxChars);
  const source = await loadNovel(input);
  const directory = await canonicalDestination(
    resolve(output ?? join(source.directory, 'translations', target)),
  );
  if (
    isWithin(directory, source.directory) ||
    (isWithin(source.directory, directory) &&
      !isWithin(join(source.directory, 'translations'), directory))
  ) {
    throw new Error(
      'Translation output must not overlap the source files; use its translations directory or a separate directory.',
    );
  }
  for (const name of ['cache', 'chapters']) {
    const path = join(directory, name);
    if ((await canonicalDestination(path)) !== path) {
      throw new Error('Translation cache and chapter directories must not be symlinks.');
    }
  }
  const config = { version: 1, provider: translator.identity, maxChars };
  // Only the OpenAI v2 prompt has a compatible predecessor; preserve every other field.
  const legacyConfig =
    config.provider.provider === 'openai' && config.provider.promptVersion === '2'
      ? { ...config, provider: { ...config.provider, promptVersion: '1' } }
      : null;
  const unique = new Map();
  function plan(text) {
    return splitText(text, maxChars).map((part) => {
      const key = hash(JSON.stringify({ config, text: part.text }));
      if (!unique.has(key)) unique.set(key, { key, source: part.text, translated: null });
      return { key, separator: part.separator };
    });
  }
  const book = { title: plan(source.manifest.title), summary: plan(source.manifest.summary) };
  const chapters = source.chapters.map((chapter) => ({
    source: chapter,
    title: plan(chapter.title),
    group: plan(chapter.group),
    body: plan(chapter.body.text),
    preface: plan(notes ? chapter.preface.text : ''),
    afterword: plan(notes ? chapter.afterword.text : ''),
  }));
  for (const chunk of unique.values()) {
    if (refresh) continue;
    let cached = await cachedChunk(directory, chunk.key, chunk.source, translator.identity);
    if (!cached && legacyConfig) {
      const legacyKey = hash(JSON.stringify({ config: legacyConfig, text: chunk.source }));
      cached = await cachedChunk(directory, legacyKey, chunk.source, translator.identity);
      if (cached) chunk.legacyCache = cached;
    }
    if (cached) chunk.translated = cached.text;
  }
  const pending = [...unique.values()].filter((chunk) => chunk.translated === null);
  const stats = {
    directory,
    chapters: chapters.length,
    uniqueChunks: unique.size,
    cachedChunks: unique.size - pending.length,
    pendingRequests: pending.length,
    pendingCharacters: pending.reduce((sum, chunk) => sum + Array.from(chunk.source).length, 0),
  };
  log(
    `${dryRun ? 'Dry run' : 'Translation'}: ${stats.chapters} chapters, ${stats.pendingRequests} pending requests, ${stats.pendingCharacters} source characters, ${stats.cachedChunks} cached chunks, concurrency ${concurrency}.`,
  );
  if (dryRun) {
    if (importBlog) log('Private blog import requested; dry run will not modify blog content.');
    return stats;
  }
  await mkdir(join(directory, 'cache'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'chapters'), { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, 'manifest.json');
  const manifest = {
    version: 1,
    machineTranslated: true,
    complete: false,
    sourceUrl: source.manifest.url,
    sourceFingerprint: hash(
      JSON.stringify({ manifest: source.manifest, chapters: source.chapters }),
    ),
    language: target,
    config,
    notes,
    startedAt: new Date().toISOString(),
  };
  await atomicJson(manifestPath, manifest);
  let nextChunk = 0;
  let failure;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (!failed && nextChunk < pending.length) {
      const index = nextChunk++;
      const chunk = pending[index];
      try {
        log(`[${index + 1}/${pending.length}] Translating chunk ${chunk.key.slice(0, 12)}`);
        const translated = await translator.translate(chunk.source, {
          onRetry: (event) =>
            log(
              `[${index + 1}/${pending.length}] Retry ${event.attempt}/${event.retries} in ${event.delay} ms for chunk ${chunk.key.slice(0, 12)}: ${event.reason}`,
            ),
        });
        const issue = translationQualityIssue(chunk.source, translated, translator.identity);
        if (issue) throw new Error(issue);
        chunk.translated = translated.trim();
        await atomicJson(join(directory, 'cache', `${chunk.key}.json`), {
          version: 1,
          key: chunk.key,
          text: chunk.translated,
          checksum: hash(chunk.translated),
          translatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error instanceof Error ? error : new Error('Translation chunk failed.');
        }
      }
    }
  });
  // Drain in-flight work and cache its successes before exporting or starting the next book.
  await Promise.all(workers);
  if (failed) throw failure;
  for (const chunk of unique.values()) {
    if (chunk.legacyCache) {
      await atomicJson(join(directory, 'cache', `${chunk.key}.json`), {
        ...chunk.legacyCache,
        key: chunk.key,
      });
    }
  }
  function render(parts) {
    return parts
      .map((part) => unique.get(part.key).translated + part.separator)
      .join('')
      .trim();
  }
  const title = render(book.title);
  const summary = render(book.summary);
  const text = [title, source.manifest.author, source.manifest.url, summary];
  const md = [
    `# ${asMarkdown(title)}`,
    asMarkdown(source.manifest.author),
    source.manifest.url,
    asMarkdown(summary),
  ];
  const exported = [];
  let lastGroup = '';
  for (const item of chapters) {
    const chapter = {
      version: 1,
      machineTranslated: true,
      sourceUrl: item.source.url,
      sourceRevision: item.source.revision,
      title: render(item.title),
      group: render(item.group),
    };
    if (chapter.group && chapter.group !== lastGroup) {
      lastGroup = chapter.group;
      text.push(lastGroup);
      md.push(`## ${asMarkdown(lastGroup)}`);
    }
    text.push(chapter.title);
    md.push(`### ${asMarkdown(chapter.title)}`);
    for (const section of ['preface', 'body', 'afterword']) {
      const translated = render(item[section]);
      chapter[section] = { text: translated, markdown: asMarkdown(translated) };
      text.push(translated);
      md.push(chapter[section].markdown);
    }
    const file = `chapters/${item.source.id}.json`;
    await atomicJson(join(directory, file), chapter);
    exported.push({
      title: chapter.title,
      group: chapter.group,
      sourceUrl: chapter.sourceUrl,
      file,
    });
  }
  await atomicWrite(join(directory, 'novel.txt'), text.filter(Boolean).join('\n\n') + '\n');
  await atomicWrite(join(directory, 'novel.md'), md.filter(Boolean).join('\n\n') + '\n');
  await atomicJson(manifestPath, {
    ...manifest,
    complete: true,
    title,
    summary,
    author: source.manifest.author,
    chapters: exported,
    completedAt: new Date().toISOString(),
  });
  log(`Saved translation to ${directory}`);
  if (importBlog) stats.book = await importTranslatedBook(directory, { log });
  return stats;
}

export async function batchTranslate(
  root,
  {
    warn = console.warn,
    log = console.log,
    createTranslator,
    translator,
    concurrency = 4,
    ...options
  } = {},
) {
  validateConcurrency(concurrency);
  if (options.output !== undefined) {
    throw new Error(
      '--output is only supported for a single book; batch books use their own translations directories.',
    );
  }
  const factory = createTranslator ?? (translator ? () => translator : null);
  if (!factory) throw new Error('batchTranslate requires a translator or createTranslator.');
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => resolve(root, entry.name))
    .sort();
  const books = [];
  for (const directory of candidates) {
    const name = basename(directory);
    try {
      const manifest = await json(join(directory, 'manifest.json'));
      if (
        manifest?.version !== 1 ||
        manifest.complete !== true ||
        !Array.isArray(manifest.chapters) ||
        !manifest.chapters.length
      ) {
        warn(
          `Skip ${name}: not a complete version-1 crawler manifest (${manifest?.complete === false ? 'crawling unfinished' : 'invalid'}).`,
        );
        continue;
      }
      books.push(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      warn(`Skip ${name}: no manifest.json found; not a crawler output directory.`);
    }
  }
  if (!books.length) {
    warn(`Scan root ${root}: no complete books to translate.`);
    return { total: 0, translated: 0, failed: 0, results: [] };
  }
  log(
    `Scan root ${root}: ${books.length} book(s) in serial order, up to ${concurrency} concurrent chunks per book.`,
  );
  const results = [];
  let sharedTranslator = translator;
  for (const [index, directory] of books.entries()) {
    const name = basename(directory);
    log(`=== [${index + 1}/${books.length}] ${name} ===`);
    try {
      sharedTranslator ??= factory();
      const stats = await translateNovel(directory, {
        ...options,
        concurrency,
        translator: sharedTranslator,
        log: (message) => log(`[${name}] ${message}`),
      });
      results.push({ book: name, ok: true, stats });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Book translation failed.';
      warn(`[${name}] FAILED: ${message}`);
      results.push({ book: name, ok: false, error: message });
    }
  }
  results.sort((a, b) => (a.book < b.book ? -1 : a.book > b.book ? 1 : 0));
  const translated = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  log(
    `\nBatch done: ${translated.length} translated, ${failed.length} failed, of ${books.length} scanned.`,
  );
  for (const result of failed) log(`  FAILED ${result.book}: ${result.error}`);
  return {
    total: books.length,
    translated: translated.length,
    failed: failed.length,
    results,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: 'string', default: 'openai' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      source: { type: 'string', default: 'ja' },
      target: { type: 'string', default: 'zh-Hans' },
      output: { type: 'string', short: 'o' },
      'chunk-chars': { type: 'string', default: '2000' },
      'max-output-tokens': { type: 'string', default: '4096' },
      'max-output-tokens-limit': { type: 'string' },
      interval: { type: 'string', default: '1000' },
      retries: { type: 'string', default: '5' },
      'retry-delay': { type: 'string', default: '1000' },
      notes: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'import-blog': { type: 'boolean', default: false },
      'scan-root': { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm translate:syosetu <crawler-output-directory> [options]
   or:  pnpm translate:syosetu --scan-root DIR [options]

  --scan-root DIR          Batch-translate every complete book directory under DIR.
                           Each immediate subdirectory is treated as one crawler output;
                           incomplete books are skipped with a warning and a failing book
                           does not abort the rest of the batch.
  --concurrency N          Concurrent chunks within ONE book (default: 4, range: 1-32).
                           Books are always translated one at a time; 1 disables chunk concurrency.
  --provider NAME          openai (default), deepl, libretranslate
  --model ID               Required for openai; or TRANSLATE_MODEL
  --base-url URL           Provider API base; or TRANSLATE_BASE_URL
  --source CODE            Source language (default: ja)
  --target CODE            Target language (default: zh-Hans)
  -o, --output DIR         Single book only; default: <input>/translations/<target>
  --chunk-chars N          Max Unicode characters per request (default: 2000)
  --max-output-tokens N    Initial per-chunk LLM output budget (default: 4096)
  --max-output-tokens-limit N
                           Length-retry ceiling (default: max(initial budget, 32768));
                           must be >= initial budget. Only length retries grow the budget.
  --interval MS            Request spacing (default: 1000)
  --retries N              Extra attempts per chunk (default: 5, range: 0-20)
  --retry-delay MS         Initial retry backoff (default: 1000, range: 1-60000)
  --notes                  Translate author prefaces and afterwords too
  --refresh                Ignore existing translation chunks
  --dry-run                Validate input and estimate uncached work; no API calls/writes
  --import-blog            Import completed translation into the blog as a PRIVATE book

Credentials: TRANSLATE_API_KEY environment variable only (never a CLI argument).
Remote translation sends text to the selected provider and may incur charges.
Only translate content you are authorized to process. Source files stay unchanged.`);
    return;
  }
  const scanRoot = values['scan-root'];
  if (scanRoot && positionals.length)
    throw new Error('Provide either a single book directory or --scan-root DIR, not both.');
  if (!scanRoot && positionals.length !== 1)
    throw new Error(
      'Provide one crawler output directory, or use --scan-root DIR to translate a directory of books in batch. Use --help for usage.',
    );
  const retries = Number(values.retries);
  if (!values.retries.trim() || !Number.isSafeInteger(retries) || retries < 0 || retries > 20)
    throw new Error('--retries must be an integer between 0 and 20.');
  const retryDelay = Number(values['retry-delay']);
  if (!Number.isSafeInteger(retryDelay) || retryDelay < 1 || retryDelay > 60000)
    throw new Error('--retry-delay must be an integer between 1 and 60000.');
  const maxOutputTokens = Number(values['max-output-tokens']);
  const maxOutputTokensLimit =
    values['max-output-tokens-limit'] === undefined
      ? undefined
      : Number(values['max-output-tokens-limit']);
  if (values.provider === 'openai') {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
      throw new Error('--max-output-tokens must be a positive safe integer.');
    if (
      maxOutputTokensLimit !== undefined &&
      (!Number.isSafeInteger(maxOutputTokensLimit) ||
        maxOutputTokensLimit < 1 ||
        maxOutputTokensLimit < maxOutputTokens)
    ) {
      throw new Error(
        '--max-output-tokens-limit must be a positive safe integer >= --max-output-tokens.',
      );
    }
  }
  const maxChars = Number(values['chunk-chars']);
  splitText('', maxChars);
  const dryRun = values['dry-run'] === true;
  // Reuse one provider across the serial batch to preserve request spacing and cooldowns.
  // The factory resolves the same effective identity for planning and execution.
  // Placeholders allow credential-free planning; dry runs never call translate().
  const createTranslator = () =>
    createTranslationProvider({
      provider: values.provider,
      model: values.model ?? process.env.TRANSLATE_MODEL ?? (dryRun ? 'dry-run' : undefined),
      baseUrl: values['base-url'] ?? process.env.TRANSLATE_BASE_URL,
      apiKey: dryRun ? process.env.TRANSLATE_API_KEY || 'dry-run' : process.env.TRANSLATE_API_KEY,
      source: values.source,
      target: values.target,
      interval: Number(values.interval),
      retries,
      retryDelay,
      maxOutputTokens,
      maxOutputTokensLimit,
    });
  const concurrency = Number(values.concurrency);
  validateConcurrency(concurrency);
  if (scanRoot) {
    const summary = await batchTranslate(scanRoot, {
      createTranslator,
      concurrency,
      output: values.output,
      maxChars,
      notes: values.notes,
      refresh: values.refresh,
      dryRun: values['dry-run'],
      importBlog: values['import-blog'],
    });
    if (summary.failed) process.exitCode = 1;
  } else {
    await translateNovel(positionals[0], {
      translator: createTranslator(),
      concurrency,
      output: values.output,
      maxChars,
      notes: values.notes,
      refresh: values.refresh,
      dryRun: values['dry-run'],
      importBlog: values['import-blog'],
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Translation stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

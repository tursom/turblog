// @ts-nocheck
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import TurndownService from 'turndown';

export const ORIGIN = 'https://novel18.syosetu.com';
const USER_AGENT = 'TurblogNovelCrawler/1.0';
const BODY =
  '#novel_honbun, .p-novel__text:not(.p-novel__text--preface):not(.p-novel__text--afterword)';
const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const compact = (value) => value.replace(/\s+/gu, ' ').trim();

export function normalizeNovel(input) {
  if (/^n\d+[a-z]+$/i.test(input)) input = `${ORIGIN}/${input.toLowerCase()}/`;
  const url = new URL(input);
  const match = url.pathname.match(/^\/(n\d+[a-z]+)(?:\/\d+)?\/?$/i);
  if (url.origin !== ORIGIN || url.username || url.password || !match) {
    throw new Error(`Expected a novel URL on ${ORIGIN} or an N-code (for example n1234ab).`);
  }
  const ncode = match[1].toLowerCase();
  return { ncode, url: `${ORIGIN}/${ncode}/` };
}

function scopedUrl(href, base, ncode, kind) {
  const url = new URL(href, base);
  const pattern =
    kind === 'index' ? new RegExp(`^/${ncode}/$`) : new RegExp(`^/${ncode}/[1-9]\\d*/$`);
  if (url.origin !== ORIGIN || url.username || url.password || !pattern.test(url.pathname)) {
    throw new Error(`Unexpected ${kind} link; refusing to leave this novel.`);
  }
  url.hash = '';
  if (kind === 'index') {
    if (
      [...url.searchParams.keys()].some((key) => key !== 'p') ||
      url.searchParams.getAll('p').length > 1 ||
      (url.search && !/^[1-9]\d*$/.test(url.searchParams.get('p') ?? ''))
    ) {
      throw new Error('Unexpected pagination query.');
    }
    if (url.searchParams.get('p') === '1') url.search = '';
  } else {
    url.search = '';
  }
  return url.href;
}

function document(html) {
  const $ = load(html);
  if (
    $(
      'input[type="password"], iframe[src*="captcha"], .g-recaptcha, .cf-turnstile, #challenge-form',
    ).length ||
    /Just a moment|年齢認証|年齢確認/.test($('title').text())
  ) {
    throw new Error(
      'Age confirmation, login or verification page encountered; access was not bypassed.',
    );
  }
  return $;
}

export function parseIndex(html, url, ncode, previousGroup = '') {
  const $ = document(html);
  const title = compact($('.p-novel__title, .novel_title').first().text());
  const author = compact($('.p-novel__author, .novel_writername').first().text()).replace(
    /^作者[：:]\s*/,
    '',
  );
  const summary = $('#novel_ex, .p-novel__summary').first().text().trim();
  let group = previousGroup;
  const chapters = [];
  $('.p-eplist__chapter-title, .chapter_title, .p-eplist__sublist, .novel_sublist2').each(
    (_, element) => {
      const item = $(element);
      if (item.is('.p-eplist__chapter-title, .chapter_title')) {
        group = compact(item.text());
        return;
      }
      const link = item.find('a.p-eplist__subtitle, dd.subtitle a, a').first();
      if (!link.attr('href') || !compact(link.text()))
        throw new Error('Invalid chapter entry in index.');
      const chapterUrl = scopedUrl(link.attr('href'), url, ncode, 'chapter');
      const update = item.find('.p-eplist__update, .long_update');
      const revision = digest(
        JSON.stringify([
          compact(link.text()),
          compact(update.text()),
          update
            .find('[title]')
            .map((_, node) => $(node).attr('title'))
            .get(),
        ]),
      );
      chapters.push({ url: chapterUrl, title: compact(link.text()), group, revision });
    },
  );
  const nextLink = $('a.c-pager__item--next, a[rel="next"]').first().attr('href');
  const next = nextLink ? scopedUrl(nextLink, url, ncode, 'index') : null;
  const oneshot = chapters.length === 0 && $(BODY).length > 0;
  if (!chapters.length && !oneshot)
    throw new Error(
      'No chapter list or novel body found; the page may be unavailable or its structure changed.',
    );
  return { title, author, summary, chapters, next, group, oneshot };
}

function extract($, selector) {
  const nodes = $(selector).clone();
  nodes.find('script, style, iframe, img, rt, rp').remove();
  const html = nodes
    .map((_, node) => $.html(node))
    .get()
    .join('\n');
  const plain = load(html);
  plain('br').replaceWith('\n');
  plain('p, div').append('\n\n');
  return {
    text: plain
      .root()
      .text()
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    markdown: markdown.turndown(html).trim(),
  };
}

export function parseChapter(html, fallbackTitle) {
  const $ = document(html);
  const body = extract($, BODY);
  if (!body.text || !body.markdown)
    throw new Error('Missing or empty chapter body; refusing to cache this page.');
  return {
    title:
      compact($('.p-novel__title, .novel_subtitle, .novel_title').first().text()) || fallbackTitle,
    body,
    preface: extract($, '#novel_p, .p-novel__text--preface'),
    afterword: extract($, '#novel_a, .p-novel__text--afterword'),
  };
}

function networkFailure(error) {
  const codes = new Set();
  function collect(value, depth = 0) {
    if (!value || depth > 3) return;
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value.code))
      codes.add(value.code);
    if (value.name === 'TimeoutError' || value.name === 'AbortError') codes.add(value.name);
    collect(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const item of value.errors) collect(item, depth + 1);
  }
  collect(error);
  const message = String(error?.message || 'fetch failed')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  return `Network request failed: ${message}${codes.size ? ` (${[...codes].join(', ')})` : ''}`;
}

export function createClient({
  interval = 1500,
  timeout = 30000,
  retries = 5,
  retryDelay = 3000,
  log = console.log,
  fetchImpl = fetch,
  wait = sleep,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 2_147_483_647)
    throw new Error('Request interval must be at least 1000 ms and fit a timer.');
  for (const [name, value, minimum, maximum] of [
    ['retries', retries, 0, 20],
    ['retryDelay', retryDelay, 1000, 60000],
    ['timeout', timeout, 1000, 300000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  let delay = interval;
  let lastRequest = null;
  let robots;

  async function retry(url, attempt, reason, retryAfter = null) {
    if (attempt >= retries) {
      throw new Error(
        `${reason} after ${attempt + 1} attempts: ${url}. Re-run the same command to resume cached chapters.`,
      );
    }
    const value = retryAfter?.trim();
    const serverDelay =
      value && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value ?? '') - now();
    if (serverDelay > 300000)
      throw new Error('Server requested a long Retry-After; stop and retry later.');
    const backoff = Math.max(
      Math.min(retryDelay * 2 ** attempt, 60000),
      Number.isFinite(serverDelay) ? serverDelay : 0,
      lastRequest === null ? 0 : delay - (now() - lastRequest),
    );
    log(`Retry ${attempt + 1}/${retries} in ${Math.ceil(backoff)} ms: ${reason}; ${url}`);
    await wait(backoff);
  }

  async function discard(response) {
    try {
      await response?.body?.cancel();
    } catch {
      /* The stream may already be closed or locked. */
    }
  }

  async function request(url, isRobots = false) {
    if (new URL(url).origin !== ORIGIN) throw new Error('Refusing an off-site request.');
    if (!isRobots && (!robots || robots.isAllowed(url, USER_AGENT) === false)) {
      throw new Error('Request denied by robots.txt (or robots.txt has not been loaded).');
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (lastRequest !== null) await wait(Math.max(0, delay - (now() - lastRequest)));
      lastRequest = now();
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { 'User-Agent': USER_AGENT, Cookie: 'over18=yes' },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        await retry(url, attempt, networkFailure(error));
        continue;
      }
      // Classify HTTP errors before reading bodies: an unreadable 403 is still terminal.
      if (!response.ok) {
        await discard(response);
        if (response.status >= 300 && response.status < 400) {
          throw new Error(
            `Redirect refused for ${url}; check the URL or open it in a browser to verify access.`,
          );
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          await retry(url, attempt, `HTTP ${response.status}`, response.headers.get('retry-after'));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${url}. Access restrictions are not bypassed.`);
      }
      if (!isRobots && !/text\/html/i.test(response.headers.get('content-type') ?? '')) {
        await discard(response);
        throw new Error(`Expected HTML: ${url}`);
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        await discard(response);
        await retry(url, attempt, networkFailure(error));
        continue;
      }
      if (isRobots && /<\s*(?:!doctype|html)/i.test(text))
        throw new Error('robots.txt returned HTML; refusing to crawl.');
      return text;
    }
  }

  return {
    async init() {
      const url = `${ORIGIN}/robots.txt`;
      robots = robotsParser(url, await request(url, true));
      const crawlDelay = robots.getCrawlDelay(USER_AGENT);
      if (Number.isFinite(crawlDelay)) delay = Math.max(delay, crawlDelay * 1000);
    },
    get: (url) => request(url),
  };
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

async function readCached(path, chapter) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      value?.version === 1 &&
      value.url === chapter.url &&
      value.revision === chapter.revision &&
      typeof value.title === 'string' &&
      ['body', 'preface', 'afterword'].every(
        (key) => typeof value[key]?.text === 'string' && typeof value[key]?.markdown === 'string',
      ) &&
      value.body.text &&
      value.body.markdown &&
      value.checksum === digest(JSON.stringify(value.body))
    )
      return value;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

export async function crawlNovel(
  input,
  {
    adult = false,
    output = 'tmp/syosetu',
    interval = 1500,
    retries = 5,
    retryDelay = 3000,
    timeout = 30000,
    refresh = false,
    notes = false,
    client,
    log = console.log,
  } = {},
) {
  if (!adult)
    throw new Error(
      'This site is 18+. Pass --adult only if you are at least 18 and eligible to access it.',
    );
  const novel = normalizeNovel(input);
  client ??= createClient({ interval, retries, retryDelay, timeout, log });
  await client.init();
  const firstHtml = await client.get(novel.url);
  let index = parseIndex(firstHtml, novel.url, novel.ncode);
  if (!index.title)
    throw new Error('Novel title is missing; refusing to create an unnamed download.');
  const metadata = {
    version: 1,
    ...novel,
    title: index.title,
    author: index.author,
    summary: index.summary,
  };
  const chapters = [...index.chapters];
  const visited = new Set([novel.url]);
  while (index.next) {
    if (visited.has(index.next) || visited.size >= 1000)
      throw new Error('Pagination loop or page limit reached.');
    const next = index.next;
    visited.add(next);
    log(`Index page ${visited.size}`);
    index = parseIndex(await client.get(next), next, novel.ncode, index.group);
    if (index.oneshot) throw new Error('Unexpected short story inside a paginated index.');
    chapters.push(...index.chapters);
  }
  if (!chapters.length) {
    chapters.push({
      url: novel.url,
      title: metadata.title,
      group: '',
      revision: digest(firstHtml),
    });
  } else {
    const urls = new Set();
    for (const chapter of chapters) {
      if (urls.has(chapter.url))
        throw new Error('Duplicate chapter URL; index may have changed during download.');
      urls.add(chapter.url);
    }
  }
  const directory = resolve(output, novel.ncode);
  await mkdir(join(directory, 'chapters'), { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, 'manifest.json');
  const manifest = { ...metadata, complete: false, fetchedAt: new Date().toISOString(), chapters };
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const results = [];
  for (const [position, chapter] of chapters.entries()) {
    const id = chapter.url === novel.url ? 'oneshot' : new URL(chapter.url).pathname.split('/')[2];
    const path = join(directory, 'chapters', `${id}.json`);
    let cached = refresh ? null : await readCached(path, chapter);
    log(`[${position + 1}/${chapters.length}] ${cached ? 'Cached' : 'Downloading'} ${chapter.url}`);
    if (!cached) {
      const html = chapter.url === novel.url ? firstHtml : await client.get(chapter.url);
      const content = parseChapter(html, chapter.title);
      cached = {
        version: 1,
        ...chapter,
        ...content,
        checksum: digest(JSON.stringify(content.body)),
        fetchedAt: new Date().toISOString(),
      };
      await atomicWrite(path, JSON.stringify(cached, null, 2) + '\n');
    }
    results.push({ ...cached, title: chapter.title, group: chapter.group });
  }
  const textParts = [metadata.title, metadata.author, metadata.url, metadata.summary];
  const mdParts = [
    `# ${markdown.escape(metadata.title)}`,
    markdown.escape(metadata.author),
    metadata.url,
    markdown.escape(metadata.summary),
  ];
  let group = '';
  for (const chapter of results) {
    if (chapter.group && chapter.group !== group) {
      group = chapter.group;
      textParts.push(group);
      mdParts.push(`## ${markdown.escape(group)}`);
    }
    textParts.push(chapter.title);
    mdParts.push(`### ${markdown.escape(chapter.title)}`);
    for (const section of notes ? ['preface', 'body', 'afterword'] : ['body']) {
      textParts.push(chapter[section].text);
      mdParts.push(chapter[section].markdown);
    }
  }
  await atomicWrite(join(directory, 'novel.txt'), textParts.filter(Boolean).join('\n\n') + '\n');
  await atomicWrite(join(directory, 'novel.md'), mdParts.filter(Boolean).join('\n\n') + '\n');
  await atomicWrite(manifestPath, JSON.stringify({ ...manifest, complete: true }, null, 2) + '\n');
  log(`Saved ${results.length} chapters to ${directory}`);
  return { directory, chapters: results.length };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      adult: { type: 'boolean', default: false },
      output: { type: 'string', short: 'o', default: 'tmp/syosetu' },
      interval: { type: 'string', default: '1500' },
      retries: { type: 'string', default: '5' },
      'retry-delay': { type: 'string', default: '3000' },
      timeout: { type: 'string', default: '30000' },
      refresh: { type: 'boolean', default: false },
      notes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm crawl:syosetu <novel-url|ncode> --adult [options]

Download one eligible, accessible work for authorized local use.
  --adult           Confirm you are at least 18 and eligible to access the site
  -o, --output DIR  Output root (default: tmp/syosetu)
  --interval MS     Minimum request interval (default: 1500, minimum: 1000)
  --retries N       Retries after the first attempt (default: 5, range: 0-20)
  --retry-delay MS  Initial exponential backoff (default: 3000, range: 1000-60000)
  --timeout MS      Per-attempt timeout including body (default: 30000, range: 1000-300000)
  --refresh         Re-download cached chapters
  --notes           Include author prefaces and afterwords in exports
  -h, --help        Show help

Outputs: <output>/<ncode>/{manifest.json,novel.txt,novel.md,chapters/*.json}
No site-wide discovery, image downloads, login or verification bypass.`);
    return;
  }
  if (positionals.length !== 1)
    throw new Error('Provide exactly one novel URL or N-code. Use --help for usage.');
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 1000)
    throw new Error('--interval must be a number of at least 1000 ms.');
  await crawlNovel(positionals[0], {
    ...values,
    interval,
    retries: Number(values.retries),
    retryDelay: Number(values['retry-delay']),
    timeout: Number(values.timeout),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Crawler stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

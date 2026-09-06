// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import {
  ORIGIN,
  normalizeNovel,
  parseIndex,
  parseChapter,
  crawlNovel,
  createClient,
} from './crawl-syosetu.mjs';

const NCODE = 'n1234ab';
const ROOT = `${ORIGIN}/${NCODE}/`;
const chapterUrl = (id) => `${ROOT}${id}/`;

before(() => {
  mock.method(globalThis, 'fetch', () => {
    throw new Error('Real network access is forbidden in this test suite.');
  });
});
after(() => mock.restoreAll());

function entry(
  id,
  {
    title = `Stage ${id}`,
    updated = '2026/01/01',
    revision = '2026/01/02',
    href = chapterUrl(id),
  } = {},
) {
  return `<div class="p-eplist__sublist"><a class="p-eplist__subtitle" href="${href}">${title}</a>
    <div class="p-eplist__update">${updated}<span title="${revision}">(revised)</span></div></div>`;
}

function indexHtml(contents = entry(1), next = '') {
  return `<h1 class="p-novel__title"> The Clockwork Observatory </h1>
    <div class="p-novel__author">&#20316;&#32773;&#65306; Mira Vale </div>
    <div class="p-novel__summary">A team repairs a mountain observatory.</div>
    ${contents}${next ? `<a class="c-pager__item--next" href="${next}">Next</a>` : ''}`;
}

function chapterHtml(body = '<p>The telescope opened.</p>', title = 'A Clear Night') {
  return `<h1 class="p-novel__title">${title}</h1>
    <div class="p-novel__text p-novel__text--preface"><p>Before the journey.</p></div>
    <div class="p-novel__text">${body}</div>
    <div class="p-novel__text p-novel__text--afterword"><p>Thanks for reading.</p></div>`;
}

for (const input of [NCODE, 'N1234AB', ROOT, `${ROOT}42/?source=test#part`]) {
  test(`normalizeNovel canonicalizes ${input}`, () => {
    assert.deepEqual(normalizeNovel(input), { ncode: NCODE, url: ROOT });
  });
}

for (const input of [
  'not-a-code',
  'https://example.test/n1234ab/',
  `http://novel18.syosetu.com/${NCODE}/`,
  `${ORIGIN}/n1234ab/extra/`,
  `${ORIGIN}/`,
  `https://user:pass@novel18.syosetu.com/${NCODE}/`,
]) {
  test(`normalizeNovel rejects ${input}`, () => {
    assert.throws(() => normalizeNovel(input));
  });
}

test('parseIndex reads modern metadata, groups, canonical chapter URLs and pagination', () => {
  const parsed = parseIndex(
    indexHtml(
      `<div class="p-eplist__chapter-title"> Volume   One </div>${entry(1, { title: ' The   Lens ', href: './1/?tracking=x#top' })}${entry(2)}`,
      '?p=2#top',
    ),
    ROOT,
    NCODE,
  );
  assert.equal(parsed.title, 'The Clockwork Observatory');
  assert.equal(parsed.author, 'Mira Vale');
  assert.equal(parsed.summary, 'A team repairs a mountain observatory.');
  assert.equal(parsed.next, `${ROOT}?p=2`);
  assert.equal(parsed.oneshot, false);
  assert.equal(parsed.group, 'Volume One');
  assert.deepEqual(
    parsed.chapters.map(({ url, title, group }) => ({ url, title, group })),
    [
      { url: chapterUrl(1), title: 'The Lens', group: 'Volume One' },
      { url: chapterUrl(2), title: 'Stage 2', group: 'Volume One' },
    ],
  );
  assert.match(parsed.chapters[0].revision, /^[a-f0-9]{64}$/);
});

test('parseIndex supports legacy directory markup and rel=next', () => {
  const parsed = parseIndex(
    `<h1 class="novel_title">Old Observatory</h1>
    <div class="novel_writername">&#20316;&#32773;: Mira Vale</div><div id="novel_ex">A quiet expedition.</div>
    <div class="chapter_title">Volume One</div><dl class="novel_sublist2">
    <dd class="subtitle"><a href="/${NCODE}/1/">The Map</a></dd>
    <dt class="long_update">2026/01/01<span title="2026/01/02">(revised)</span></dt></dl>
    <a rel="next" href="?p=2">Next</a>`,
    ROOT,
    NCODE,
  );
  assert.equal(parsed.title, 'Old Observatory');
  assert.equal(parsed.author, 'Mira Vale');
  assert.equal(parsed.summary, 'A quiet expedition.');
  assert.equal(parsed.next, `${ROOT}?p=2`);
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].url, chapterUrl(1));
  assert.equal(parsed.chapters[0].title, 'The Map');
  assert.equal(parsed.chapters[0].group, 'Volume One');
  assert.match(parsed.chapters[0].revision, /^[a-f0-9]{64}$/);
});

test('parseIndex carries a volume across pages and switches at the next heading', () => {
  const first = parseIndex(
    indexHtml(`<div class="chapter_title">Volume One</div>${entry(1)}`, '?p=2'),
    ROOT,
    NCODE,
  );
  const second = parseIndex(
    indexHtml(`${entry(2)}<div class="chapter_title">Volume Two</div>${entry(3)}`),
    first.next,
    NCODE,
    first.group,
  );
  assert.deepEqual(
    second.chapters.map(({ group }) => group),
    ['Volume One', 'Volume Two'],
  );
  assert.equal(second.group, 'Volume Two');
  assert.equal(second.next, null);
});

test('parseIndex revision tracks title, visible update and revision tooltip, but not layout', () => {
  const revision = (html) => parseIndex(html, ROOT, NCODE).chapters[0].revision;
  const original = revision(indexHtml());
  for (const change of [
    { title: 'A New Lens' },
    { updated: '2026/02/01' },
    { revision: '2026/02/02' },
  ]) {
    assert.notEqual(revision(indexHtml(entry(1, change))), original);
  }
  assert.equal(
    revision(indexHtml(entry(1, { title: ' Stage   1 ' })).replaceAll('<div', '\n<div')),
    original,
  );
});

for (const href of [
  'https://example.test/n1234ab/1/',
  '//example.test/n1234ab/1/',
  `${ORIGIN}/n9999zz/1/`,
  `https://user:pass@novel18.syosetu.com/${NCODE}/1/`,
  `/${NCODE}/0/`,
  `/${NCODE}/../n9999zz/1/`,
]) {
  test(`parseIndex refuses out-of-scope chapter link ${href}`, () => {
    assert.throws(
      () => parseIndex(indexHtml(entry(1, { href })), ROOT, NCODE),
      /Unexpected chapter link/,
    );
  });
}

for (const href of [
  'https://example.test/n1234ab/?p=2',
  '/n9999zz/?p=2',
  '?p=0',
  '?p=-1',
  '?p=2&p=3',
  '?p=2&other=1',
  '?p=abc',
  '?p=1.5',
]) {
  test(`parseIndex refuses unsafe pagination ${href}`, () => {
    assert.throws(
      () => parseIndex(indexHtml(entry(1), href), ROOT, NCODE),
      /Unexpected (index link|pagination query)/,
    );
  });
}

test('parseIndex canonicalizes page one and rejects malformed or absent entries', () => {
  assert.equal(parseIndex(indexHtml(entry(1), '?p=1#top'), `${ROOT}?p=2`, NCODE).next, ROOT);
  for (const html of [
    '<div class="p-eplist__sublist"><a>No URL</a></div>',
    entry(1, { title: ' ' }),
  ]) {
    assert.throws(() => parseIndex(indexHtml(html), ROOT, NCODE), /Invalid chapter entry/);
  }
  assert.throws(
    () => parseIndex('<h1>Unavailable</h1>', ROOT, NCODE),
    /No chapter list or novel body/,
  );
});

for (const [name, html] of [
  ['modern', chapterHtml()],
  [
    'legacy',
    '<h1 class="novel_title">A Small Telescope</h1><div id="novel_honbun"><p>A star appeared.</p></div>',
  ],
]) {
  test(`parseIndex recognizes a ${name} short story`, () => {
    const parsed = parseIndex(html, ROOT, NCODE);
    assert.equal(parsed.oneshot, true);
    assert.deepEqual(parsed.chapters, []);
    assert.equal(parsed.next, null);
  });
}

for (const [name, html] of [
  [
    'modern',
    chapterHtml(
      '<p>The <strong>bright</strong> star.<br>A second line.</p><p>Another paragraph.</p>',
    ),
  ],
  [
    'legacy',
    '<h1 class="novel_subtitle">A Clear Night</h1><div id="novel_p"><p>Before the journey.</p></div><div id="novel_honbun"><p>The <strong>bright</strong> star.<br>A second line.</p><p>Another paragraph.</p></div><div id="novel_a"><p>Thanks for reading.</p></div>',
  ],
]) {
  test(`parseChapter separates ${name} body and notes and preserves text and Markdown`, () => {
    const parsed = parseChapter(html, 'Fallback');
    assert.equal(parsed.title, 'A Clear Night');
    assert.equal(parsed.body.text, 'The bright star.\nA second line.\n\nAnother paragraph.');
    assert.equal(
      parsed.body.markdown,
      'The **bright** star.  \nA second line.\n\nAnother paragraph.',
    );
    assert.deepEqual(parsed.preface, {
      text: 'Before the journey.',
      markdown: 'Before the journey.',
    });
    assert.deepEqual(parsed.afterword, {
      text: 'Thanks for reading.',
      markdown: 'Thanks for reading.',
    });
  });
}

test('parseChapter keeps ruby base text and removes annotations and non-content elements', () => {
  const parsed = parseChapter(
    chapterHtml(
      '<p><ruby>Hoshi<rp>(</rp><rt>star-reading</rt><rp>)</rp></ruby> &amp; sky.</p><script>script-noise</script><style>style-noise</style><iframe>frame-noise</iframe><img alt="image-noise" src="https://example.test/picture.png">',
    ),
  );
  assert.deepEqual(parsed.body, { text: 'Hoshi & sky.', markdown: 'Hoshi & sky.' });
});

test('parseChapter uses the fallback title and returns empty optional notes', () => {
  assert.deepEqual(
    parseChapter('<div id="novel_honbun"><p>A star appeared.</p></div>', 'The First Star'),
    {
      title: 'The First Star',
      body: { text: 'A star appeared.', markdown: 'A star appeared.' },
      preface: { text: '', markdown: '' },
      afterword: { text: '', markdown: '' },
    },
  );
});

for (const [name, gate] of [
  ['login', '<input type="password">'],
  ['age confirmation', '<title>&#24180;&#40802;&#30906;&#35469;</title>'],
  ['age authentication', '<title>&#24180;&#40802;&#35469;&#35388;</title>'],
  ['challenge title', '<title>Just a moment</title>'],
  ['captcha frame', '<iframe src="/captcha"></iframe>'],
  ['recaptcha', '<div class="g-recaptcha"></div>'],
  ['turnstile', '<div class="cf-turnstile"></div>'],
  ['challenge form', '<form id="challenge-form"></form>'],
]) {
  test(`both parsers reject ${name} even with otherwise valid content`, () => {
    assert.throws(() => parseIndex(gate + indexHtml(), ROOT, NCODE), /login or verification page/);
    assert.throws(
      () => parseChapter(gate + chapterHtml(), 'Fallback'),
      /login or verification page/,
    );
  });
}

for (const [name, html] of [
  ['missing body', '<p>Navigation only</p>'],
  ['empty body', chapterHtml(' \n<br>')],
  ['notes only', '<div class="p-novel__text p-novel__text--preface">A note</div>'],
  [
    'non-content body',
    chapterHtml(
      '<script>noise</script><img alt="noise" src="/image.png"><ruby><rt>reading</rt></ruby>',
    ),
  ],
]) {
  test(`parseChapter rejects ${name}`, () => {
    assert.throws(() => parseChapter(html, 'Fallback'), /Missing or empty chapter body/);
  });
}

async function crawlFixture(t, pages = { [ROOT]: indexHtml(), [chapterUrl(1)]: chapterHtml() }) {
  const output = await mkdtemp(join(tmpdir(), 'turblog-syosetu-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const routes = new Map(Object.entries(pages));
  const calls = [];
  const client = {
    init: t.mock.fn(async () => {}),
    get: async (url) => {
      assert.ok(client.init.mock.callCount() > 0, 'init must precede page requests');
      calls.push(url);
      assert.ok(routes.has(url), `Unexpected offline request: ${url}`);
      const result = routes.get(url);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const directory = join(output, NCODE);
  return {
    output,
    directory,
    routes,
    calls,
    client,
    run: (options = {}) =>
      crawlNovel(NCODE, { adult: true, output, client, log: () => {}, ...options }),
    text: (path) => readFile(join(directory, path), 'utf8'),
    json: async (path) => JSON.parse(await readFile(join(directory, path), 'utf8')),
    put: (path, contents) => writeFile(join(directory, path), contents),
  };
}

test('crawlNovel downloads paginated volumes in order and exports body without notes by default', async (t) => {
  const f = await crawlFixture(t, {
    [ROOT]: indexHtml(`<div class="chapter_title">Volume One</div>${entry(1)}`, '?p=2'),
    [`${ROOT}?p=2`]: indexHtml(`${entry(2)}<div class="chapter_title">Volume Two</div>${entry(3)}`),
    [chapterUrl(1)]: chapterHtml('<p>The first lens.</p>'),
    [chapterUrl(2)]: chapterHtml('<p>The second lens.</p>'),
    [chapterUrl(3)]: chapterHtml('<p>The third lens.</p>'),
  });
  assert.deepEqual(await f.run(), { directory: f.directory, chapters: 3 });
  assert.deepEqual(f.calls, [ROOT, `${ROOT}?p=2`, chapterUrl(1), chapterUrl(2), chapterUrl(3)]);
  assert.equal(f.client.init.mock.callCount(), 1);
  const manifest = await f.json('manifest.json');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.ncode, NCODE);
  assert.equal(manifest.url, ROOT);
  assert.equal(manifest.title, 'The Clockwork Observatory');
  assert.equal(manifest.author, 'Mira Vale');
  assert.equal(manifest.summary, 'A team repairs a mountain observatory.');
  assert.ok(Number.isFinite(Date.parse(manifest.fetchedAt)));
  assert.deepEqual(
    manifest.chapters.map(({ group }) => group),
    ['Volume One', 'Volume One', 'Volume Two'],
  );
  const text = await f.text('novel.txt');
  const md = await f.text('novel.md');
  assert.equal(
    text,
    `The Clockwork Observatory\n\nMira Vale\n\n${ROOT}\n\nA team repairs a mountain observatory.\n\nVolume One\n\nStage 1\n\nThe first lens.\n\nStage 2\n\nThe second lens.\n\nVolume Two\n\nStage 3\n\nThe third lens.\n`,
  );
  assert.equal(
    md,
    `# The Clockwork Observatory\n\nMira Vale\n\n${ROOT}\n\nA team repairs a mountain observatory.\n\n## Volume One\n\n### Stage 1\n\nThe first lens.\n\n### Stage 2\n\nThe second lens.\n\n## Volume Two\n\n### Stage 3\n\nThe third lens.\n`,
  );
  const cached = await f.json('chapters/1.json');
  assert.equal(cached.url, chapterUrl(1));
  assert.equal(cached.revision, manifest.chapters[0].revision);
  assert.equal(cached.preface.text, 'Before the journey.');
  assert.equal(cached.afterword.markdown, 'Thanks for reading.');
  assert.match(cached.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(f.directory)).sort(), [
    'chapters',
    'manifest.json',
    'novel.md',
    'novel.txt',
  ]);
  assert.deepEqual((await readdir(join(f.directory, 'chapters'))).sort(), [
    '1.json',
    '2.json',
    '3.json',
  ]);
});

test('crawlNovel resumes valid caches, uses current volume labels and can export cached notes', async (t) => {
  const f = await crawlFixture(t);
  await f.run();
  const original = await f.text('chapters/1.json');
  f.calls.length = 0;
  f.routes.delete(chapterUrl(1));
  f.routes.set(ROOT, indexHtml(`<div class="chapter_title">New Volume</div>${entry(1)}`));
  await f.run({ notes: true });
  assert.deepEqual(f.calls, [ROOT]);
  assert.equal(await f.text('chapters/1.json'), original);
  assert.equal((await f.json('manifest.json')).complete, true);
  for (const path of ['novel.txt', 'novel.md']) {
    const text = await f.text(path);
    assert.match(text, /New Volume/);
    assert.match(text, /Before the journey\.\n\nThe telescope opened\.\n\nThanks for reading\./);
  }
});

test('crawlNovel downloads only the chapter whose revision changed', async (t) => {
  const f = await crawlFixture(t, {
    [ROOT]: indexHtml(entry(1) + entry(2)),
    [chapterUrl(1)]: chapterHtml(),
    [chapterUrl(2)]: chapterHtml('<p>The old lens.</p>'),
  });
  await f.run();
  const first = await f.text('chapters/1.json');
  const second = await f.json('chapters/2.json');
  f.calls.length = 0;
  f.routes.delete(chapterUrl(1));
  f.routes.set(ROOT, indexHtml(entry(1) + entry(2, { revision: '2026/03/01' })));
  f.routes.set(chapterUrl(2), chapterHtml('<p>The repaired lens.</p>'));
  await f.run();
  assert.deepEqual(f.calls, [ROOT, chapterUrl(2)]);
  assert.equal(await f.text('chapters/1.json'), first);
  const revised = await f.json('chapters/2.json');
  assert.notEqual(revised.revision, second.revision);
  assert.notEqual(revised.checksum, second.checksum);
  assert.equal(revised.body.text, 'The repaired lens.');
  assert.match(await f.text('novel.txt'), /The repaired lens/);
  assert.doesNotMatch(await f.text('novel.txt'), /The old lens/);
});

test('crawlNovel refresh bypasses otherwise valid caches', async (t) => {
  const f = await crawlFixture(t);
  await f.run();
  f.calls.length = 0;
  f.routes.set(chapterUrl(1), chapterHtml('<p>A newly polished telescope.</p>'));
  await f.run({ refresh: true });
  assert.deepEqual(f.calls, [ROOT, chapterUrl(1)]);
  assert.equal((await f.json('chapters/1.json')).body.text, 'A newly polished telescope.');
});

const corruptions = [
  ['truncated JSON', () => '{"version":'],
  ['JSON null', () => 'null'],
  ['wrong schema version', (cache) => JSON.stringify({ ...cache, version: 2 })],
  ['wrong URL', (cache) => JSON.stringify({ ...cache, url: chapterUrl(99) })],
  ['wrong revision', (cache) => JSON.stringify({ ...cache, revision: 'stale' })],
  ['missing notes', (cache) => JSON.stringify({ ...cache, preface: null })],
  ['invalid title', (cache) => JSON.stringify({ ...cache, title: null })],
  ['empty body', (cache) => JSON.stringify({ ...cache, body: { text: '', markdown: '' } })],
  [
    'changed body without checksum update',
    (cache) =>
      JSON.stringify({ ...cache, body: { text: 'Corrupted text.', markdown: 'Corrupted text.' } }),
  ],
  ['wrong checksum', (cache) => JSON.stringify({ ...cache, checksum: 'invalid' })],
];
for (const [name, corrupt] of corruptions) {
  test(`crawlNovel repairs a cache containing ${name}`, async (t) => {
    const f = await crawlFixture(t);
    await f.run();
    const original = await f.json('chapters/1.json');
    await f.put('chapters/1.json', corrupt(original));
    f.calls.length = 0;
    await f.run();
    assert.deepEqual(f.calls, [ROOT, chapterUrl(1)]);
    const repaired = await f.json('chapters/1.json');
    assert.deepEqual(repaired.body, original.body);
    assert.equal(repaired.checksum, original.checksum);
    assert.equal((await f.json('manifest.json')).complete, true);
  });
}

test('crawlNovel downloads a missing cache again', async (t) => {
  const f = await crawlFixture(t);
  await f.run();
  await rm(join(f.directory, 'chapters/1.json'));
  f.calls.length = 0;
  await f.run();
  assert.deepEqual(f.calls, [ROOT, chapterUrl(1)]);
  assert.equal((await f.json('chapters/1.json')).body.text, 'The telescope opened.');
});

for (const [name, failure, expected] of [
  ['request failure', new Error('Offline simulated failure'), /Offline simulated failure/],
  ['empty chapter', chapterHtml(''), /Missing or empty chapter body/],
  ['login page', '<input type="password">', /login or verification page/],
]) {
  test(`crawlNovel leaves complete:false after ${name} and resumes the remaining chapter`, async (t) => {
    const f = await crawlFixture(t, {
      [ROOT]: indexHtml(entry(1) + entry(2)),
      [chapterUrl(1)]: chapterHtml(),
      [chapterUrl(2)]: failure,
    });
    await assert.rejects(f.run(), expected);
    assert.equal((await f.json('manifest.json')).complete, false);
    const first = await f.text('chapters/1.json');
    for (const path of ['chapters/2.json', 'novel.txt', 'novel.md']) {
      await assert.rejects(f.text(path), { code: 'ENOENT' });
    }
    f.calls.length = 0;
    f.routes.delete(chapterUrl(1));
    f.routes.set(chapterUrl(2), chapterHtml('<p>The expedition returned.</p>'));
    await f.run();
    assert.deepEqual(f.calls, [ROOT, chapterUrl(2)]);
    assert.equal(await f.text('chapters/1.json'), first);
    assert.equal((await f.json('manifest.json')).complete, true);
  });
}

test('crawlNovel caches a short story without fetching its body twice and notices edits', async (t) => {
  const f = await crawlFixture(t, { [ROOT]: chapterHtml() });
  assert.deepEqual(await f.run(), { directory: f.directory, chapters: 1 });
  assert.deepEqual(f.calls, [ROOT]);
  const original = await f.text('chapters/oneshot.json');
  assert.equal((await f.json('manifest.json')).chapters[0].url, ROOT);
  assert.deepEqual(await readdir(join(f.directory, 'chapters')), ['oneshot.json']);
  f.calls.length = 0;
  await f.run();
  assert.deepEqual(f.calls, [ROOT]);
  assert.equal(await f.text('chapters/oneshot.json'), original);
  f.calls.length = 0;
  f.routes.set(ROOT, chapterHtml('<p>A new star appeared.</p>'));
  await f.run();
  assert.deepEqual(f.calls, [ROOT]);
  assert.notEqual((await f.json('chapters/oneshot.json')).revision, JSON.parse(original).revision);
  assert.match(await f.text('novel.txt'), /A new star appeared/);
});

test('crawlNovel requires explicit eligibility before initializing its client', async (t) => {
  const f = await crawlFixture(t);
  await assert.rejects(f.run({ adult: false }), /Pass --adult/);
  assert.equal(f.client.init.mock.callCount(), 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.output), []);
});

for (const [name, first, second, expected] of [
  ['pagination cycle', indexHtml(entry(1), '?p=2'), indexHtml(entry(2), '?p=1'), /Pagination loop/],
  ['duplicate chapter', indexHtml(entry(1), '?p=2'), indexHtml(entry(1)), /Duplicate chapter URL/],
  [
    'short story on a later page',
    indexHtml(entry(1), '?p=2'),
    chapterHtml(),
    /Unexpected short story/,
  ],
  ['missing novel title', entry(1), null, /Novel title is missing/],
]) {
  test(`crawlNovel rejects ${name} before downloading chapter content`, async (t) => {
    const f = await crawlFixture(t, { [ROOT]: first, [`${ROOT}?p=2`]: second });
    await assert.rejects(f.run(), expected);
    assert.deepEqual(f.calls, second === null ? [ROOT] : [ROOT, `${ROOT}?p=2`]);
    assert.deepEqual(await readdir(f.output), []);
  });
}

const ROBOTS_URL = `${ORIGIN}/robots.txt`;
const CLOCK_START = Date.UTC(2026, 0, 1);
const allowRobots = () =>
  new Response('User-agent: *\nDisallow:\n', { headers: { 'Content-Type': 'text/plain' } });
const htmlResponse = (body = '<p>Offline response</p>') =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const statusResponse = (status, headers = {}) =>
  new Response('Offline status response', { status, headers });

function httpFixture(t, responses, options = {}) {
  let clock = CLOCK_START;
  const pending = [...responses];
  const calls = [];
  const waits = [];
  const fetchImpl = t.mock.fn(async (url, init) => {
    calls.push({ url, init, time: clock - CLOCK_START });
    assert.ok(pending.length, `Unexpected offline fetch: ${url}`);
    const response = pending.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  const wait = t.mock.fn(async (ms) => {
    assert.ok(Number.isFinite(ms) && ms >= 0, 'wait must be finite and nonnegative');
    waits.push(ms);
    clock += ms;
  });
  const now = () => clock;
  const client = createClient({
    interval: 1000,
    retries: 2,
    retryDelay: 2000,
    log: () => {},
    ...options,
    fetchImpl,
    wait,
    now,
  });
  t.after(() => assert.equal(pending.length, 0, 'all scripted responses should be consumed'));
  return {
    client,
    calls,
    waits,
    advance: (ms) => {
      clock += ms;
    },
  };
}

for (const interval of [0, 999, -1, NaN, Infinity, '1500']) {
  test(`createClient rejects invalid interval ${interval}`, () => {
    assert.throws(() => createClient({ interval }), /at least 1000 ms/);
  });
}

test('createClient refuses requests before robots initialization and refuses external requests', async (t) => {
  const h = httpFixture(t, []);
  await assert.rejects(h.client.get(ROOT), /robots.txt has not been loaded/);
  await assert.rejects(h.client.get('https://example.test/'), /off-site request/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.waits, []);
});

test('createClient enforces robots rules using the crawler user agent and specific Allow paths', async (t) => {
  const robots = new Response(
    `User-agent: *\nDisallow: /\n\nUser-agent: TurblogNovelCrawler\nDisallow: /${NCODE}/\nAllow: /${NCODE}/1/\n`,
  );
  const h = httpFixture(t, [robots, htmlResponse()]);
  await h.client.init();
  await assert.rejects(h.client.get(ROOT), /denied by robots.txt/);
  assert.equal(await h.client.get(chapterUrl(1)), '<p>Offline response</p>');
  await assert.rejects(h.client.get(chapterUrl(2)), /denied by robots.txt/);
  await assert.rejects(h.client.get('https://example.test/'), /off-site request/);
  assert.deepEqual(
    h.calls.map(({ url }) => url),
    [ROBOTS_URL, chapterUrl(1)],
  );
});

test('createClient honors wildcard robots disallow when there is no specific user-agent group', async (t) => {
  const h = httpFixture(t, [new Response('User-agent: *\nDisallow: /\n')]);
  await h.client.init();
  await assert.rejects(h.client.get(ROOT), /denied by robots.txt/);
  assert.deepEqual(
    h.calls.map(({ url }) => url),
    [ROBOTS_URL],
  );
});

test('createClient sends access headers, manual redirects and an abort signal; defaults to 1500 ms spacing', async (t) => {
  const h = httpFixture(t, [allowRobots(), htmlResponse(), htmlResponse()], {
    interval: undefined,
  });
  await h.client.init();
  await h.client.get(ROOT);
  await h.client.get(chapterUrl(1));
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1500, 3000],
  );
  for (const { init } of h.calls) {
    assert.equal(init.headers['User-Agent'], 'TurblogNovelCrawler/1.0');
    assert.equal(init.headers.Cookie, 'over18=yes');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
});

for (const [crawlDelay, interval, expected] of [
  [3, 1000, 3000],
  [1, 2500, 2500],
]) {
  test(`createClient uses the larger of robots delay ${crawlDelay}s and interval ${interval}ms`, async (t) => {
    const h = httpFixture(
      t,
      [
        new Response(`User-agent: *\nDisallow:\nCrawl-delay: ${crawlDelay}\n`),
        htmlResponse(),
        htmlResponse(),
      ],
      { interval },
    );
    await h.client.init();
    await h.client.get(ROOT);
    await h.client.get(chapterUrl(1));
    assert.deepEqual(
      h.calls.map(({ time }) => time),
      [0, expected, expected * 2],
    );
  });
}

test('createClient only waits for the remaining interval and never requests a negative wait', async (t) => {
  const h = httpFixture(t, [allowRobots(), htmlResponse(), htmlResponse()]);
  await h.client.init();
  h.advance(400);
  await h.client.get(ROOT);
  h.advance(1800);
  await h.client.get(chapterUrl(1));
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 2800],
  );
  assert.equal(
    h.waits.reduce((sum, ms) => sum + ms, 0),
    600,
  );
});

for (const [name, value, retryTime] of [
  ['seconds', '5', 6000],
  ['short seconds', '1', 3000],
  ['HTTP date', new Date(CLOCK_START + 8000).toUTCString(), 8000],
  ['past HTTP date', new Date(CLOCK_START - 10000).toUTCString(), 3000],
  ['invalid value', 'not-a-date', 3000],
  ['absent header', null, 3000],
]) {
  test(`createClient retries 429 with ${name} using Retry-After or exponential backoff`, async (t) => {
    const h = httpFixture(t, [
      allowRobots(),
      statusResponse(429, value === null ? {} : { 'Retry-After': value }),
      htmlResponse(),
    ]);
    await h.client.init();
    assert.equal(await h.client.get(ROOT), '<p>Offline response</p>');
    assert.deepEqual(
      h.calls.map(({ url }) => url),
      [ROBOTS_URL, ROOT, ROOT],
    );
    assert.deepEqual(
      h.calls.map(({ time }) => time),
      [0, 1000, retryTime],
    );
  });
}

for (const retryAfter of ['301', new Date(CLOCK_START + 302000).toUTCString()]) {
  test(`createClient stops on excessive Retry-After ${retryAfter}`, async (t) => {
    const h = httpFixture(t, [allowRobots(), statusResponse(429, { 'Retry-After': retryAfter })]);
    await h.client.init();
    await assert.rejects(h.client.get(ROOT), /long Retry-After/);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.waits, [1000]);
  });
}

test('createClient uses exponential backoff across two transient server failures', async (t) => {
  const h = httpFixture(t, [
    allowRobots(),
    statusResponse(503),
    statusResponse(500),
    htmlResponse(),
  ]);
  await h.client.init();
  await h.client.get(ROOT);
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 3000, 7000],
  );
});

for (const status of [429, 503]) {
  test(`createClient stops HTTP ${status} after exactly three attempts`, async (t) => {
    const h = httpFixture(t, [
      allowRobots(),
      ...Array.from({ length: 3 }, () => statusResponse(status)),
    ]);
    await h.client.init();
    await assert.rejects(h.client.get(ROOT), new RegExp(`HTTP ${status} after 3 attempts`));
    assert.deepEqual(
      h.calls.map(({ time }) => time),
      [0, 1000, 3000, 7000],
    );
    assert.deepEqual(
      h.calls.map(({ url }) => url),
      [ROBOTS_URL, ROOT, ROOT, ROOT],
    );
  });
}

test('createClient retries fetch and response-body failures without real waits', async (t) => {
  const unreadable = htmlResponse();
  unreadable.text = async () => {
    throw new Error('Offline body read failure');
  };
  const h = httpFixture(t, [
    allowRobots(),
    new Error('Offline connection failure'),
    unreadable,
    htmlResponse(),
  ]);
  await h.client.init();
  await h.client.get(ROOT);
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 3000, 7000],
  );
});

test('createClient reports the final network error after three attempts', async (t) => {
  const h = httpFixture(t, [
    allowRobots(),
    new Error('first'),
    new Error('second'),
    new Error('final offline failure'),
  ]);
  await h.client.init();
  await assert.rejects(h.client.get(ROOT), /Network request failed.*final offline failure/);
  assert.equal(h.calls.length, 4);
});

for (const status of [401, 403, 404]) {
  test(`createClient refuses HTTP ${status} without retrying or bypassing access controls`, async (t) => {
    const h = httpFixture(t, [allowRobots(), statusResponse(status)]);
    await h.client.init();
    await assert.rejects(
      h.client.get(ROOT),
      new RegExp(`HTTP ${status}.*Access restrictions are not bypassed`),
    );
    assert.deepEqual(
      h.calls.map(({ url }) => url),
      [ROBOTS_URL, ROOT],
    );
  });
}

for (const [status, location] of [
  [301, ROOT],
  [302, 'https://example.test/login'],
  [303, `${ORIGIN}/login`],
  [307, ROOT],
  [308, ROOT],
]) {
  test(`createClient refuses ${status} redirect to ${location}`, async (t) => {
    const h = httpFixture(t, [allowRobots(), statusResponse(status, { Location: location })]);
    await h.client.init();
    await assert.rejects(h.client.get(ROOT), /Redirect refused/);
    assert.deepEqual(
      h.calls.map(({ url }) => url),
      [ROBOTS_URL, ROOT],
    );
    assert.ok(h.calls.every(({ init }) => init.redirect === 'manual'));
  });
}

for (const [name, response, expected] of [
  [
    'HTML instead of robots',
    new Response('<!doctype html><html><title>Login</title></html>'),
    /robots.txt returned HTML/,
  ],
  ['forbidden robots', statusResponse(403), /HTTP 403/],
  ['missing robots', statusResponse(404), /HTTP 404/],
  [
    'redirected robots',
    statusResponse(302, { Location: 'https://example.test/robots.txt' }),
    /Redirect refused/,
  ],
]) {
  test(`createClient fails closed on ${name}`, async (t) => {
    const h = httpFixture(t, [response]);
    await assert.rejects(h.client.init(), expected);
    await assert.rejects(h.client.get(ROOT), /robots.txt has not been loaded/);
    assert.deepEqual(
      h.calls.map(({ url }) => url),
      [ROBOTS_URL],
    );
  });
}

test('retry budget survives three consecutive fetch failures and reports progress', async (t) => {
  const logs = [];
  const failure = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    });
  const h = httpFixture(
    t,
    [allowRobots(), failure(), failure(), failure(), htmlResponse('recovered')],
    {
      retries: undefined,
      retryDelay: undefined,
      log: (message) => logs.push(message),
    },
  );
  await h.client.init();
  assert.equal(await h.client.get(ROOT), 'recovered');
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 4000, 10000, 22000],
  );
  assert.equal(logs.length, 3);
  assert.match(logs[0], /Retry 1\/5.*3000 ms.*ECONNRESET/);
});

test('retry budget defaults to six total attempts and preserves the final cause', async (t) => {
  const logs = [];
  const h = httpFixture(
    t,
    [
      allowRobots(),
      ...Array.from(
        { length: 6 },
        () =>
          new TypeError('fetch failed', {
            cause: new AggregateError([
              Object.assign(new Error('DNS temporarily unavailable'), { code: 'EAI_AGAIN' }),
            ]),
          }),
      ),
    ],
    { retries: undefined, retryDelay: undefined, log: (line) => logs.push(line) },
  );
  await h.client.init();
  await assert.rejects(h.client.get(ROOT), /EAI_AGAIN.*after 6 attempts.*resume cached chapters/);
  assert.equal(logs.length, 5);
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 4000, 10000, 22000, 46000, 94000],
  );
});

test('retry budget applies a fresh configured timeout after headers and body failures', async (t) => {
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return originalTimeout(ms);
  });
  const unreadable = htmlResponse();
  unreadable.text = async () => {
    throw new DOMException('Reading body timed out', 'TimeoutError');
  };
  const logs = [];
  const h = httpFixture(
    t,
    [
      allowRobots(),
      new DOMException('Connection timed out', 'TimeoutError'),
      unreadable,
      htmlResponse(),
    ],
    {
      timeout: 60000,
      retries: 2,
      log: (line) => logs.push(line),
    },
  );
  await h.client.init();
  await h.client.get(ROOT);
  assert.deepEqual(timeouts, [60000, 60000, 60000, 60000]);
  assert.equal(new Set(h.calls.map(({ init }) => init.signal)).size, 4);
  assert.ok(logs.every((line) => line.includes('TimeoutError')));
});

test('retry budget is configurable for robots and resets for each page', async (t) => {
  const errors = () => Array.from({ length: 4 }, () => new TypeError('fetch failed'));
  const h = httpFixture(t, [...errors(), allowRobots(), ...errors(), htmlResponse()], {
    retries: 4,
    retryDelay: 1000,
  });
  await h.client.init();
  assert.equal(await h.client.get(ROOT), '<p>Offline response</p>');
  assert.equal(h.calls.length, 10);
});

test('retry budget can be disabled without sleeping after failure', async (t) => {
  const h = httpFixture(t, [new TypeError('fetch failed')], { retries: 0 });
  await assert.rejects(h.client.init(), /after 1 attempts/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('retry budget handles HTTP 408 and caps exponential waiting at sixty seconds', async (t) => {
  const h = httpFixture(
    t,
    [allowRobots(), statusResponse(408), statusResponse(503), statusResponse(429), htmlResponse()],
    {
      retries: 3,
      retryDelay: 40000,
    },
  );
  await h.client.init();
  await h.client.get(ROOT);
  assert.deepEqual(
    h.calls.map(({ time }) => time),
    [0, 1000, 41000, 101000, 161000],
  );
});

test('retry budget never retries a forbidden status even if its body is broken', async (t) => {
  const forbidden = statusResponse(403);
  forbidden.text = async () => {
    throw new Error('broken error body');
  };
  const h = httpFixture(t, [allowRobots(), forbidden], { retries: 5 });
  await h.client.init();
  await assert.rejects(h.client.get(ROOT), /HTTP 403/);
  assert.equal(h.calls.length, 2);
});

for (const options of [
  { retries: -1 },
  { retries: 1.5 },
  { retries: 21 },
  { retries: NaN },
  { retryDelay: 0 },
  { retryDelay: Infinity },
  { retryDelay: 60001 },
  { timeout: 0 },
  { timeout: Infinity },
  { timeout: 300001 },
]) {
  test(`retry budget validates options ${JSON.stringify(options)}`, () => {
    assert.throws(() => createClient(options), /retries|retryDelay|timeout/);
  });
}

for (const contentType of [null, 'application/json', 'text/plain']) {
  test(`createClient rejects a chapter with content type ${contentType}`, async (t) => {
    const response = htmlResponse();
    if (contentType === null) response.headers.delete('content-type');
    else response.headers.set('content-type', contentType);
    const h = httpFixture(t, [allowRobots(), response]);
    await h.client.init();
    await assert.rejects(h.client.get(ROOT), /Expected HTML/);
    assert.equal(h.calls.length, 2);
  });
}

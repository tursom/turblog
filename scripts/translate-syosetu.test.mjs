// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { createTranslationProvider } from './translation-providers.mjs';
import { loadNovel, splitText, translateNovel, batchTranslate } from './translate-syosetu.mjs';

const ROOT = 'https://novel18.syosetu.com/n1234ab/';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const section = (text) => ({ text, markdown: text });
const translated = (text) => `T(${text})`;
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const putJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

before(() => {
  mock.method(globalThis, 'fetch', () => {
    throw new Error('Real network access is forbidden in this test suite.');
  });
});
after(() => mock.restoreAll());

async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await snapshot(path))) {
        files[`${entry.name}/${name}`] = value;
      }
    } else if (entry.isFile()) files[entry.name] = await readFile(path, 'utf8');
  }
  return files;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turblog-translation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const output = join(root, 'output');
  await mkdir(join(source, 'chapters'), { recursive: true });
  const entries = [1, 2].map((id) => ({
    url: `${ROOT}${id}/`,
    title: `Chapter ${id}`,
    group: 'Volume One',
    revision: hash(JSON.stringify([`Chapter ${id}`, '2026/01/01', []])),
  }));
  const manifest = {
    version: 1,
    ncode: 'n1234ab',
    url: ROOT,
    title: 'Book',
    author: 'A *Writer*',
    summary: 'Summary',
    complete: true,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    chapters: entries,
  };
  const chapters = entries.map((entry, index) => {
    const body = section(index === 0 ? '\u65e5\u672c\u8a9e\u{1f680}' : 'Second body');
    return {
      version: 1,
      ...entry,
      body,
      preface: section('Before'),
      afterword: section('After'),
      checksum: hash(JSON.stringify(body)),
      fetchedAt: manifest.fetchedAt,
    };
  });
  const save = async () => {
    await putJson(join(source, 'manifest.json'), manifest);
    for (const [index, chapter] of chapters.entries()) {
      await putJson(join(source, 'chapters', `${index + 1}.json`), chapter);
    }
  };
  await save();
  await writeFile(join(source, 'novel.txt'), 'Original crawler text\n');
  await writeFile(join(source, 'novel.md'), '# Original crawler Markdown\n');
  const calls = [];
  const translator = {
    identity: {
      provider: 'mock',
      source: 'ja',
      target: 'zh-Hans',
      model: 'test',
      promptVersion: 1,
    },
    translate: async (text) => {
      calls.push(text);
      return translated(text);
    },
  };
  const chunks = [
    manifest.title,
    manifest.summary,
    entries[0].title,
    entries[0].group,
    chapters[0].body.text,
    entries[1].title,
    chapters[1].body.text,
  ];
  return {
    root,
    source,
    output,
    manifest,
    chapters,
    calls,
    translator,
    chunks,
    save,
    run: (options = {}) =>
      translateNovel(source, { translator, output, log: () => {}, ...options }),
    json: (path) => readJson(join(output, path)),
    text: (path) => readFile(join(output, path), 'utf8'),
  };
}

function offlineProvider(options = {}) {
  return createTranslationProvider({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:12345/v1',
    model: 'offline-model',
    interval: 0,
    retryDelay: 1,
    ...options,
  });
}

// Ordinary synthetic prose, with a fully copied Japanese paragraph in the bad result.
async function japaneseFixture(t) {
  const f = await fixture(t);
  f.manifest.title = '小さな町の図書館';
  f.manifest.summary = 'これは町の図書館で過ごした静かな一日の物語です。';
  const labels = ['朝の静けさ', '夕方の帰り道'];
  const bodies = [
    '朝、私は町の図書館へ歩いていきました。窓から明るい光が差し込んでいました。\n\n受付の人は笑顔で新しい本を紹介してくれました。私は窓のそばに座って、その本をゆっくり読み始めました。',
    '夕方になると、私は本を閉じて外に出ました。涼しい風が吹いていて、家までの道を静かに歩きました。',
  ];
  for (const [index, chapter] of f.chapters.entries()) {
    chapter.title = f.manifest.chapters[index].title = labels[index];
    chapter.group = f.manifest.chapters[index].group = '町での一日';
    chapter.body = section(bodies[index]);
    chapter.checksum = hash(JSON.stringify(chapter.body));
  }
  await f.save();
  f.chunks = [
    f.manifest.title,
    f.manifest.summary,
    labels[0],
    f.manifest.chapters[0].group,
    bodies[0],
    labels[1],
    bodies[1],
  ];
  f.translations = new Map(
    f.chunks.map((text, index) => [
      text,
      [
        '小镇图书馆',
        '这是在小镇图书馆度过的宁静一天的故事。',
        '清晨的宁静',
        '小镇的一天',
        '清晨，我步行前往小镇图书馆。明亮的阳光从窗户照进来。\n\n接待员微笑着向我介绍了一本新书。我坐在窗边，慢慢读起那本书。',
        '傍晚的归途',
        '到了傍晚，我合上书走到外面。凉风吹拂，我安静地沿着回家的路走去。',
      ][index],
    ]),
  );
  f.partial =
    '清晨，我步行前往小镇图书馆。明亮的阳光从窗户照进来。\n\n' + bodies[0].split('\n\n')[1];
  f.translator.identity = offlineProvider().identity;
  f.translator.translate = async (text) => {
    f.calls.push(text);
    return f.translations.get(text);
  };
  return f;
}

function cacheKey(identity, text, maxChars = 2000) {
  return hash(JSON.stringify({ config: { version: 1, provider: identity, maxChars }, text }));
}

async function seedCache(f, identity, source, text = f.translations.get(source)) {
  await mkdir(join(f.output, 'cache'), { recursive: true });
  const key = cacheKey(identity, source);
  const record = {
    version: 1,
    key,
    text,
    checksum: hash(text),
    translatedAt: '2026-01-02T03:04:05.000Z',
  };
  await putJson(join(f.output, 'cache', `${key}.json`), record);
  return record;
}

async function seedBook(f, identity) {
  return Promise.all(f.chunks.map((text) => seedCache(f, identity, text)));
}

test('splitText counts Unicode code points, preserves paragraphs, and bounds long lines', () => {
  assert.deepEqual(splitText(' \n\t '), []);
  assert.deepEqual(splitText('  first\n\nsecond  ', 8), [
    { text: 'first', separator: '\n\n' },
    { text: 'second', separator: '' },
  ]);
  for (const input of [
    '\u65e5\u{1f680}\u672c\u{1f680}\u8a9e',
    'x'.repeat(31),
    'one two. three! four?',
  ]) {
    for (const limit of [1, 4, 9]) {
      const parts = splitText(input, limit);
      assert.ok(parts.length > 0);
      for (const part of parts) {
        assert.ok(part.text.trim());
        assert.ok(Array.from(part.text).length <= limit);
        assert.doesNotMatch(
          part.text,
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
        );
      }
      assert.equal(
        parts
          .map(({ text }) => text)
          .join('')
          .replace(/\s/g, ''),
        input.replace(/\s/g, ''),
      );
    }
  }
  const input = 'first\n\nsecond\n\nthird';
  assert.equal(
    splitText(input, 9)
      .map((p) => p.text + p.separator)
      .join(''),
    input,
  );
});

test('splitText rejects invalid chunk sizes even for empty text', () => {
  for (const size of [0, -1, 1.5, NaN, Infinity, '4', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => splitText('', size), /positive integer/);
  }
});

test('loadNovel accepts crawler checksums and uses current manifest chapter labels', async (t) => {
  const f = await fixture(t);
  f.manifest.chapters[0].group = 'Current Volume';
  await f.save();
  const loaded = await loadNovel(f.source);
  assert.equal(loaded.directory, f.source);
  assert.deepEqual(
    loaded.chapters.map((c) => c.id),
    ['1', '2'],
  );
  assert.equal(loaded.chapters[0].group, 'Current Volume');
  assert.deepEqual(loaded.chapters[0].body, f.chapters[0].body);
});

test('invalid or stale source is rejected before any API call or output write', async (t) => {
  const cases = [
    [
      'incomplete',
      (f) => {
        f.manifest.complete = false;
      },
    ],
    [
      'manifest version',
      (f) => {
        f.manifest.version = 2;
      },
    ],
    [
      'empty chapter list',
      (f) => {
        f.manifest.chapters = [];
      },
    ],
    [
      'wrong novel',
      (f) => {
        f.manifest.ncode = 'n9999zz';
      },
    ],
    [
      'checksum',
      (f) => {
        f.chapters[1].body.markdown += 'changed';
      },
    ],
    [
      'revision',
      (f) => {
        f.chapters[1].revision = hash('new revision');
      },
    ],
    [
      'chapter URL',
      (f) => {
        f.chapters[1].url = `${ROOT}99/`;
      },
    ],
    [
      'missing notes',
      (f) => {
        f.chapters[1].preface = null;
      },
    ],
    [
      'empty body',
      (f) => {
        f.chapters[1].body = section(' ');
        f.chapters[1].checksum = hash(JSON.stringify(f.chapters[1].body));
      },
    ],
    [
      'duplicate',
      (f) => {
        f.manifest.chapters[1] = f.manifest.chapters[0];
      },
    ],
  ];
  for (const [name, change] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      change(f);
      await f.save();
      const original = await snapshot(f.source);
      await assert.rejects(f.run());
      assert.deepEqual(f.calls, []);
      await assert.rejects(readdir(f.output), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(f.source), original);
    });
});

test('dry runs count unique Unicode characters and cached work without writes or API calls', async (t) => {
  const f = await fixture(t);
  const original = await snapshot(f.root);
  const stats = await f.run({ dryRun: true });
  assert.deepEqual(stats, {
    directory: f.output,
    chapters: 2,
    uniqueChunks: 7,
    cachedChunks: 0,
    pendingRequests: 7,
    pendingCharacters: f.chunks.reduce((sum, text) => sum + Array.from(text).length, 0),
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await snapshot(f.root), original);
  await f.run();
  f.calls.length = 0;
  const cached = await snapshot(f.root);
  assert.deepEqual(await f.run({ dryRun: true }), {
    ...stats,
    cachedChunks: 7,
    pendingRequests: 0,
    pendingCharacters: 0,
  });
  assert.deepEqual(await f.run({ dryRun: true, refresh: true }), stats);
  const withNotes = await f.run({ dryRun: true, notes: true });
  assert.equal(withNotes.uniqueChunks, 9);
  assert.equal(withNotes.cachedChunks, 7);
  assert.equal(withNotes.pendingRequests, 2);
  assert.equal(withNotes.pendingCharacters, 'BeforeAfter'.length);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await snapshot(f.root), cached);
});

test('exports translated metadata, ordered groups/body/notes, escaped Markdown, and unchanged source', async (t) => {
  const f = await fixture(t);
  const original = await snapshot(f.source);
  f.translator.translate = async (text) => {
    f.calls.push(text);
    return `*${text}* <tag> & [x](url)`;
  };
  await f.run({ notes: true });
  const manifest = await f.json('manifest.json');
  assert.equal(manifest.complete, true);
  assert.equal(manifest.machineTranslated, true);
  assert.equal(manifest.sourceUrl, ROOT);
  assert.equal(manifest.language, 'zh-Hans');
  assert.equal(manifest.author, f.manifest.author);
  assert.equal(manifest.title, '*Book* <tag> & [x](url)');
  assert.equal(manifest.summary, '*Summary* <tag> & [x](url)');
  assert.deepEqual(manifest.config, {
    version: 1,
    provider: f.translator.identity,
    maxChars: 2000,
  });
  assert.equal(manifest.notes, true);
  assert.match(manifest.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(manifest.completedAt)));
  assert.deepEqual(
    manifest.chapters.map((c) => c.file),
    ['chapters/1.json', 'chapters/2.json'],
  );
  const chapter = await f.json('chapters/1.json');
  assert.equal(chapter.sourceRevision, f.chapters[0].revision);
  assert.equal(chapter.sourceUrl, `${ROOT}1/`);
  assert.equal(chapter.machineTranslated, true);
  for (const name of ['preface', 'body', 'afterword']) {
    const text = f.chapters[0][name].text;
    assert.equal(chapter[name].text, `*${text}* <tag> & [x](url)`);
    assert.equal(chapter[name].markdown, `\\*${text}\\* &lt;tag&gt; &amp; \\[x\\](url)`);
  }
  const md = await f.text('novel.md');
  assert.ok(md.startsWith('# \\*Book\\* &lt;tag&gt; &amp; \\[x\\](url)\n'));
  assert.equal(md.split('\n## ').length - 1, 1);
  assert.equal(md.split('\n### ').length - 1, 2);
  assert.ok(md.includes('A \\*Writer\\*'));
  const text = await f.text('novel.txt');
  assert.ok(text.indexOf(chapter.preface.text) < text.indexOf(chapter.body.text));
  assert.ok(text.indexOf(chapter.body.text) < text.indexOf(chapter.afterword.text));
  assert.equal(f.calls.length, 9);
  assert.ok(!f.calls.includes(f.manifest.author));
  assert.deepEqual(await snapshot(f.source), original);
});

test('same configuration resumes with zero calls; source edits invalidate only changed text', async (t) => {
  const f = await fixture(t);
  await f.run();
  const first = await f.text('chapters/1.json');
  const fingerprint = (await f.json('manifest.json')).sourceFingerprint;
  f.calls.length = 0;
  assert.equal((await f.run()).pendingRequests, 0);
  assert.deepEqual(f.calls, []);
  f.chapters[1].body = section('Revised body');
  f.chapters[1].checksum = hash(JSON.stringify(f.chapters[1].body));
  f.chapters[1].revision = f.manifest.chapters[1].revision = hash('revised');
  await f.save();
  assert.equal((await f.run()).pendingRequests, 1);
  assert.deepEqual(f.calls, ['Revised body']);
  assert.equal(await f.text('chapters/1.json'), first);
  assert.notEqual((await f.json('manifest.json')).sourceFingerprint, fingerprint);
  assert.equal((await f.json('chapters/2.json')).body.text, translated('Revised body'));
});

test('chunked bodies render paragraph separators and reuse unchanged chunks after edits', async (t) => {
  const f = await fixture(t);
  f.chapters[0].body = section('aaaa\n\nbbbb\n\ncccc');
  f.chapters[0].checksum = hash(JSON.stringify(f.chapters[0].body));
  await f.save();
  await f.run({ maxChars: 6 });
  assert.ok(f.calls.every((text) => Array.from(text).length <= 6));
  assert.equal((await f.json('chapters/1.json')).body.text, 'T(aaaa)\n\nT(bbbb)\n\nT(cccc)');
  f.calls.length = 0;
  f.chapters[0].body = section('aaaa\n\ndddd\n\ncccc');
  f.chapters[0].checksum = hash(JSON.stringify(f.chapters[0].body));
  await f.save();
  await f.run({ maxChars: 6 });
  assert.deepEqual(f.calls, ['dddd']);
  assert.equal((await f.json('chapters/1.json')).body.text, 'T(aaaa)\n\nT(dddd)\n\nT(cccc)');
});

test('a crawler short story exports as oneshot without inventing numbered chapters', async (t) => {
  const f = await fixture(t);
  f.manifest.chapters = [{ ...f.manifest.chapters[0], url: ROOT }];
  await f.save();
  await putJson(join(f.source, 'chapters', 'oneshot.json'), { ...f.chapters[0], url: ROOT });
  await rm(join(f.source, 'chapters', '1.json'));
  await rm(join(f.source, 'chapters', '2.json'));
  assert.equal((await f.run()).chapters, 1);
  assert.deepEqual(await readdir(join(f.output, 'chapters')), ['oneshot.json']);
  assert.equal((await f.json('chapters/oneshot.json')).sourceUrl, ROOT);
});

for (const change of ['model', 'target', 'maxChars']) {
  test(`changing ${change} invalidates cached chunks in the same output directory`, async (t) => {
    const f = await fixture(t);
    await f.run();
    f.calls.length = 0;
    if (change !== 'maxChars') f.translator.identity[change] = change === 'target' ? 'en' : 'other';
    const stats = await f.run(change === 'maxChars' ? { maxChars: 1000 } : {});
    assert.equal(stats.cachedChunks, 0);
    assert.equal(stats.pendingRequests, 7);
    assert.deepEqual(f.calls, f.chunks);
  });
}

test('source-identical legacy caches are retranslated while valid caches remain reusable', async (t) => {
  const f = await fixture(t);
  await f.run();
  const config = (await f.json('manifest.json')).config;
  const original = f.chapters[0].body.text;
  const key = hash(JSON.stringify({ config, text: original }));
  const echo = `  ${original}\r\n`;
  await putJson(join(f.output, 'cache', `${key}.json`), {
    version: 1,
    key,
    text: echo,
    checksum: hash(echo),
  });
  f.calls.length = 0;
  const before = await snapshot(f.output);
  const plan = await f.run({ dryRun: true });
  assert.equal(plan.pendingRequests, 1);
  assert.equal(plan.cachedChunks, 6);
  assert.deepEqual(await snapshot(f.output), before, 'dry run must not delete invalid caches');
  assert.deepEqual(f.calls, []);
  const stats = await f.run();
  assert.equal(stats.pendingRequests, 1);
  assert.deepEqual(f.calls, [original]);
  assert.equal((await f.json(`cache/${key}.json`)).text, translated(original));
  assert.equal((await f.json('chapters/1.json')).body.text, translated(original));
  for (const [path, contents] of Object.entries(before)) {
    if (path.startsWith('cache/') && path !== `cache/${key}.json`)
      assert.equal(await f.text(path), contents);
  }
});

for (const version of ['1', '2']) {
  test(`partly untranslated OpenAI v${version} cache is repaired selectively without refresh`, async (t) => {
    const f = await japaneseFixture(t);
    assert.equal(f.translator.identity.promptVersion, '2');
    const identity = { ...f.translator.identity, promptVersion: version };
    await seedBook(f, identity);
    const source = f.chapters[0].body.text;
    const bad = await seedCache(f, identity, source, f.partial);
    const before = await snapshot(f.root);
    const plan = await f.run({ dryRun: true });
    assert.equal(plan.cachedChunks, 6);
    assert.equal(plan.pendingRequests, 1);
    assert.equal(plan.pendingCharacters, Array.from(source).length);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await snapshot(f.root), before);
    const stats = await f.run();
    assert.equal(stats.pendingRequests, 1);
    assert.deepEqual(f.calls, [source]);
    assert.equal((await f.json('manifest.json')).complete, true);
    assert.equal((await f.json('chapters/1.json')).body.text, f.translations.get(source));
    assert.ok(!(await f.text('novel.txt')).includes(f.partial));
    for (const text of f.chunks) {
      const key = cacheKey(f.translator.identity, text);
      assert.equal((await f.json(`cache/${key}.json`)).text, f.translations.get(text));
    }
    for (const [path, contents] of Object.entries(before)) {
      if (
        path.startsWith('output/cache/') &&
        (version === '1' || !path.endsWith(`${bad.key}.json`))
      ) {
        assert.equal(await readFile(join(f.root, path), 'utf8'), contents);
      }
    }
    f.calls.length = 0;
    assert.equal((await f.run()).pendingRequests, 0);
    assert.deepEqual(f.calls, []);
  });
}

test('valid v1 caches migrate without requests, preserve text/timestamps, and prefer valid v2', async (t) => {
  const f = await japaneseFixture(t);
  const identity = f.translator.identity;
  const oldIdentity = { ...identity, promptVersion: '1' };
  await seedBook(f, oldIdentity);
  const preserved = await seedCache(
    f,
    oldIdentity,
    f.chunks[1],
    `  ${f.translations.get(f.chunks[1])}\r\n`,
  );
  const preferred = await seedCache(f, identity, f.chunks[0], '小镇上的图书馆');
  // An invalid current entry must not conceal a valid legacy translation.
  await seedCache(f, identity, f.chunks[4], f.partial);
  const before = await snapshot(f.root);
  const plan = await f.run({ dryRun: true });
  assert.equal(plan.cachedChunks, 7);
  assert.equal(plan.pendingRequests, 0);
  assert.equal(plan.pendingCharacters, 0);
  assert.deepEqual(await snapshot(f.root), before);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.run()).pendingRequests, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.json(`cache/${preferred.key}.json`), preferred);
  const newKey = cacheKey(identity, f.chunks[1]);
  assert.deepEqual(await f.json(`cache/${newKey}.json`), { ...preserved, key: newKey });
  assert.equal((await f.json('manifest.json')).title, preferred.text);
  for (const text of f.chunks) {
    const oldKey = cacheKey(oldIdentity, text);
    assert.equal(await f.text(`cache/${oldKey}.json`), before[`output/cache/${oldKey}.json`]);
    const key = cacheKey(identity, text);
    assert.equal((await f.json(`cache/${key}.json`)).translatedAt, preserved.translatedAt);
  }
});

test('legacy migration never aliases other configurations, providers, or prompt versions', async (t) => {
  for (const [field, value] of [
    ['endpoint', 'http://127.0.0.1:12346/v1/chat/completions'],
    ['model', 'different-model'],
    ['maxOutputTokens', 8192],
    ['source', 'ja-JP'],
    ['target', 'zh-Hant'],
    ['maxChars', 1000],
    ['provider', 'deepl'],
    ['provider', 'libretranslate'],
    ['promptVersion', '3'],
    ['promptVersion', 2],
  ]) {
    await t.test(`${field}=${value}`, async (t) => {
      const f = await japaneseFixture(t);
      const oldIdentity = { ...f.translator.identity, promptVersion: '1' };
      if (field === 'provider') oldIdentity.provider = value;
      await seedBook(f, oldIdentity);
      if (field !== 'maxChars')
        f.translator.identity = { ...f.translator.identity, [field]: value };
      const before = await snapshot(f.root);
      const options = field === 'maxChars' ? { maxChars: value } : {};
      const plan = await f.run({ ...options, dryRun: true });
      assert.equal(plan.cachedChunks, 0);
      assert.equal(plan.pendingRequests, 7);
      assert.deepEqual(await snapshot(f.root), before);
      await f.run(options);
      assert.deepEqual(f.calls, f.chunks);
    });
  }
});

test('legacy cache checksum, content quality, and exact version are validated', async (t) => {
  for (const problem of ['checksum', 'echo', 'empty', 'numeric-version', 'older-version']) {
    await t.test(problem, async (t) => {
      const f = await japaneseFixture(t);
      const oldIdentity = {
        ...f.translator.identity,
        promptVersion: problem === 'numeric-version' ? 1 : problem === 'older-version' ? '0' : '1',
      };
      const source = f.chunks[0];
      const record = await seedCache(
        f,
        oldIdentity,
        source,
        problem === 'echo' ? source : problem === 'empty' ? ' ' : undefined,
      );
      if (problem === 'checksum') {
        await putJson(join(f.output, 'cache', `${record.key}.json`), {
          ...record,
          checksum: hash('wrong'),
        });
      }
      const before = await snapshot(f.root);
      assert.equal((await f.run({ dryRun: true })).cachedChunks, 0);
      assert.deepEqual(await snapshot(f.root), before);
    });
  }
});

test('refresh bypasses even valid compatible v1 caches', async (t) => {
  const f = await japaneseFixture(t);
  await seedBook(f, { ...f.translator.identity, promptVersion: '1' });
  const before = await snapshot(f.root);
  assert.equal((await f.run({ dryRun: true, refresh: true })).pendingRequests, 7);
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await f.run({ refresh: true })).cachedChunks, 0);
  assert.deepEqual(f.calls, f.chunks);
});

test('custom partial Japanese output fails without caching, exporting, or pipeline retries', async (t) => {
  const f = await japaneseFixture(t);
  f.translator.translate = async (text) => {
    f.calls.push(text);
    return f.partial;
  };
  await assert.rejects(f.run({ concurrency: 1 }), {
    message: 'Translation contains untranslated Japanese text.',
  });
  assert.deepEqual(f.calls, [f.chunks[0]]);
  assert.equal((await f.json('manifest.json')).complete, false);
  assert.deepEqual(await readdir(join(f.output, 'cache')), []);
  assert.deepEqual(await readdir(join(f.output, 'chapters')), []);
  for (const file of ['novel.txt', 'novel.md']) {
    await assert.rejects(f.text(file), { code: 'ENOENT' });
  }
});

test('cache and custom-output partial Japanese checks use effective source and target languages', async (t) => {
  for (const [source, target, rejected] of [
    ['JA-jp', 'ZH-hant', true],
    ['ja', 'zt', true],
    ['ja', 'en', false],
    ['en', 'zh-Hans', false],
  ]) {
    await t.test(`${source} -> ${target}`, async (t) => {
      const f = await japaneseFixture(t);
      f.translator.identity = { ...f.translator.identity, source, target };
      await seedBook(f, f.translator.identity);
      await seedCache(f, f.translator.identity, f.chunks[4], f.partial);
      assert.equal((await f.run({ dryRun: true })).pendingRequests, rejected ? 1 : 0);
      f.translator.translate = async () => f.partial;
      if (rejected) {
        await assert.rejects(f.run({ refresh: true, concurrency: 1 }), /untranslated Japanese/);
      } else {
        assert.equal((await f.run({ refresh: true })).pendingRequests, 7);
        assert.equal((await f.json('chapters/1.json')).body.text, f.partial);
      }
    });
  }
});

test('exhausted real-provider quality retries leave an incomplete book and retain only successes', async (t) => {
  const f = await japaneseFixture(t);
  const budgets = [];
  const logs = [];
  const translator = offlineProvider({
    retries: 2,
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      const text = payload.messages[1].content;
      f.calls.push(text);
      budgets.push(payload.max_tokens);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: text === f.chunks[4] ? f.partial : f.translations.get(text),
            },
          },
        ],
      });
    },
  });
  await assert.rejects(
    f.run({ translator, concurrency: 1, log: (line) => logs.push(line) }),
    /Translation contains untranslated Japanese text\. Failed after 3 attempts\./,
  );
  assert.deepEqual(f.calls, [...f.chunks.slice(0, 4), ...Array(3).fill(f.chunks[4])]);
  assert.ok(budgets.every((budget) => budget === 4096));
  assert.equal(logs.filter((line) => line.includes('] Retry ')).length, 2);
  assert.ok(logs.every((line) => !line.includes(f.partial) && !line.includes(f.chunks[4])));
  assert.equal((await f.json('manifest.json')).complete, false);
  const caches = await snapshot(join(f.output, 'cache'));
  assert.equal(Object.keys(caches).length, 4);
  assert.ok(Object.values(caches).every((record) => !JSON.parse(record).text.includes(f.partial)));
  assert.deepEqual(await readdir(join(f.output, 'chapters')), []);
  await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
  f.calls.length = 0;
  assert.equal((await f.run()).pendingRequests, 3);
  assert.deepEqual(f.calls, f.chunks.slice(4));
  for (const [file, contents] of Object.entries(caches)) {
    assert.equal(await f.text(`cache/${file}`), contents);
  }
});

test('Venice-style empty tool arrays yield complete cached Chinese exports without retries', async (t) => {
  const f = await japaneseFixture(t);
  const logs = [];
  const translator = offlineProvider({
    model: 'venice-uncensored-1-2',
    fetchImpl: async (_url, request) => {
      const text = JSON.parse(request.body).messages[1].content;
      f.calls.push(text);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            stop_reason: null,
            message: {
              role: 'assistant',
              content: f.translations.get(text),
              reasoning_content: null,
              tool_calls: [],
            },
          },
        ],
      });
    },
  });
  const stats = await f.run({ translator, log: (line) => logs.push(line) });
  assert.equal(stats.pendingRequests, f.chunks.length);
  assert.equal(f.calls.length, f.chunks.length);
  assert.ok(logs.every((line) => !line.includes('Retry')));
  assert.equal((await f.json('manifest.json')).complete, true);
  assert.equal((await f.json('chapters/1.json')).body.text, f.translations.get(f.chunks[4]));
  for (const text of f.chunks) {
    assert.equal(
      (await f.json(`cache/${cacheKey(translator.identity, text)}.json`)).text,
      f.translations.get(text),
    );
  }
  const cacheBefore = await snapshot(join(f.output, 'cache'));
  f.calls.length = 0;
  assert.equal((await f.run({ translator })).pendingRequests, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await snapshot(join(f.output, 'cache')), cacheBefore);
});

test('source echoes are retried by real providers and never cached as successful translations', async (t) => {
  const f = await fixture(t);
  const attempts = new Map();
  const logs = [];
  let clock = 0;
  const translator = createTranslationProvider({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:12345/v1',
    model: 'offline-model',
    interval: 0,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    fetchImpl: async (_url, request) => {
      const original = JSON.parse(request.body).messages[1].content;
      const count = (attempts.get(original) ?? 0) + 1;
      attempts.set(original, count);
      const config = { version: 1, provider: translator.identity, maxChars: 2000 };
      const key = hash(JSON.stringify({ config, text: original }));
      await assert.rejects(f.text(`cache/${key}.json`), { code: 'ENOENT' });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: count === 1 ? original : translated(original),
              },
            },
          ],
        }),
      );
    },
  });
  await f.run({ translator, log: (line) => logs.push(line) });
  assert.equal(attempts.size, 7);
  assert.ok([...attempts.values()].every((count) => count === 2));
  assert.equal(
    logs.filter((line) => line.includes('Retry 1/5') && line.includes('identical to the source'))
      .length,
    7,
  );
  assert.equal((await f.json('manifest.json')).complete, true);
  for (const file of await readdir(join(f.output, 'cache'))) {
    assert.ok((await f.json(`cache/${file}`)).text.startsWith('T('));
  }
  assert.equal((await f.run({ translator })).pendingRequests, 0);
});

test('a custom translator cannot cache or export a source-identical result', async (t) => {
  const f = await fixture(t);
  f.translator.translate = async (text) => text;
  await assert.rejects(f.run({ concurrency: 1 }), /identical to the source/);
  assert.equal((await f.json('manifest.json')).complete, false);
  assert.deepEqual(await readdir(join(f.output, 'cache')), []);
  await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
});

test('missing, malformed, null and checksum-corrupted chunk caches are repaired independently', async (t) => {
  const f = await fixture(t);
  await f.run();
  const files = (await readdir(join(f.output, 'cache'))).sort();
  const originals = await Promise.all(files.map((file) => f.text(`cache/${file}`)));
  await rm(join(f.output, 'cache', files[0]));
  await writeFile(join(f.output, 'cache', files[1]), '{');
  await writeFile(join(f.output, 'cache', files[2]), 'null');
  await putJson(join(f.output, 'cache', files[3]), {
    ...JSON.parse(originals[3]),
    text: 'tampered',
  });
  f.calls.length = 0;
  const stats = await f.run();
  assert.equal(stats.cachedChunks, 3);
  assert.equal(stats.pendingRequests, 4);
  assert.equal(f.calls.length, 4);
  for (const [i, file] of files.entries()) {
    const cache = await f.json(`cache/${file}`);
    assert.equal(cache.text, JSON.parse(originals[i]).text);
    assert.equal(cache.checksum, hash(cache.text));
    if (i >= 4) assert.equal(await f.text(`cache/${file}`), originals[i]);
  }
});

for (const failure of ['throw', 'empty']) {
  test(`${failure} translation leaves complete:false and resumes successful chunks`, async (t) => {
    const f = await fixture(t);
    const normal = f.translator.translate;
    f.translator.translate = async (text) => {
      if (f.calls.length === 2) {
        f.calls.push(text);
        if (failure === 'throw') throw new Error('Offline failure');
        return ' \n ';
      }
      return normal(text);
    };
    await assert.rejects(
      f.run({ concurrency: 1 }),
      failure === 'throw' ? /Offline failure/ : /empty translation/,
    );
    assert.equal((await f.json('manifest.json')).complete, false);
    const successful = f.calls.slice(0, 2);
    const caches = await snapshot(join(f.output, 'cache'));
    assert.equal(Object.keys(caches).length, 2);
    await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
    f.calls.length = 0;
    f.translator.translate = normal;
    assert.equal((await f.run()).pendingRequests, 5);
    assert.deepEqual(
      f.calls,
      f.chunks.filter((text) => !successful.includes(text)),
    );
    for (const [file, contents] of Object.entries(caches))
      assert.equal(await f.text(`cache/${file}`), contents);
    assert.equal((await f.json('manifest.json')).complete, true);
  });
}

test('CLI rejects invalid retry settings before dry-run input reads or batch scanning', async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, 'nonexistent');
  const original = await snapshot(f.root);
  for (const [flag, invalid, message] of [
    ['--retries', ['-1', '21', '1.5', 'NaN', 'Infinity', '', ' '], /--retries.*0 and 20/],
    [
      '--retry-delay',
      ['0', '-1', '60001', '1.5', 'NaN', 'Infinity', ''],
      /--retry-delay.*1 and 60000/,
    ],
  ]) {
    for (const value of invalid) {
      for (const input of [[missing], ['--scan-root', missing]]) {
        const result = spawnSync(
          process.execPath,
          [
            new URL('./translate-syosetu.mjs', import.meta.url).pathname,
            ...input,
            '--dry-run',
            `${flag}=${value}`,
          ],
          { encoding: 'utf8', timeout: 10000 },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.stderr, /ENOENT|API key|model is required/);
      }
    }
  }
  assert.deepEqual(await snapshot(f.root), original);
});

test('CLI validates OpenAI output budgets before dry runs, input reads, and batch scans', async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, 'nonexistent');
  const original = await snapshot(f.root);
  for (const flag of ['--max-output-tokens', '--max-output-tokens-limit']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', ' ', '9007199254740992']) {
      for (const input of [[missing], ['--scan-root', missing]]) {
        const result = spawnSync(
          process.execPath,
          [
            new URL('./translate-syosetu.mjs', import.meta.url).pathname,
            ...input,
            '--dry-run',
            `${flag}=${value}`,
          ],
          { encoding: 'utf8', timeout: 10000 },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(`${flag} must be a positive safe integer`));
        assert.doesNotMatch(result.stderr, /ENOENT|API key|model is required/);
      }
    }
  }
  for (const dryRun of [[], ['--dry-run']]) {
    for (const input of [[missing], ['--scan-root', missing]]) {
      const result = spawnSync(
        process.execPath,
        [
          new URL('./translate-syosetu.mjs', import.meta.url).pathname,
          ...input,
          ...dryRun,
          '--max-output-tokens',
          '8192',
          '--max-output-tokens-limit',
          '4096',
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--max-output-tokens-limit.*>= --max-output-tokens/);
      assert.doesNotMatch(result.stderr, /ENOENT|API key|model is required/);
    }
  }
  assert.deepEqual(await snapshot(f.root), original);
});

test('CLI accepts output budget boundaries and ignores output settings for non-LLM dry runs', async (t) => {
  const f = await fixture(t);
  const original = await snapshot(f.root);
  for (const options of [
    [],
    ['--max-output-tokens', '1', '--max-output-tokens-limit', '1'],
    ['--max-output-tokens', '8192', '--max-output-tokens-limit', '16384'],
    ['--max-output-tokens', '65536'],
    ['--max-output-tokens', '9007199254740991', '--max-output-tokens-limit', '9007199254740991'],
    ...['deepl', 'libretranslate'].flatMap((provider) =>
      ['0', 'NaN'].map((value) => [
        '--provider',
        provider,
        '--max-output-tokens',
        value,
        '--max-output-tokens-limit',
        value,
      ]),
    ),
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./translate-syosetu.mjs', import.meta.url).pathname,
        f.source,
        '--dry-run',
        ...options,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: 2 chapters, 7 pending requests/);
  }
  const help = spawnSync(
    process.execPath,
    [new URL('./translate-syosetu.mjs', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Initial per-chunk LLM output budget \(default: 4096\)/);
  assert.match(help.stdout, /--max-output-tokens-limit N/);
  assert.match(help.stdout, /max\(initial budget, 32768\)/);
  assert.deepEqual(await snapshot(f.root), original);
});

test('CLI accepts retry defaults and boundaries during dry-run without writes', async (t) => {
  const f = await fixture(t);
  const original = await snapshot(f.root);
  for (const options of [
    [],
    ['--retries', '0', '--retry-delay', '1'],
    ['--retries', '20', '--retry-delay', '60000'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./translate-syosetu.mjs', import.meta.url).pathname,
        f.source,
        '--dry-run',
        ...options,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: 2 chapters, 7 pending requests/);
  }
  assert.deepEqual(await snapshot(f.root), original);
});

test('retry callbacks log the pending chunk index, key, budget, delay, and reason', async (t) => {
  const f = await fixture(t);
  const logs = [];
  f.translator.translate = async (text, { onRetry }) => {
    f.calls.push(text);
    onRetry({ attempt: 1, retries: 3, delay: 1000, reason: 'Malformed translation response.' });
    return translated(text);
  };
  await f.run({ log: (message) => logs.push(message) });
  const config = (await f.json('manifest.json')).config;
  assert.deepEqual(
    logs.filter((message) => message.includes('] Retry ')),
    f.chunks.map((text, index) => {
      const key = hash(JSON.stringify({ config, text }));
      return `[${index + 1}/7] Retry 1/3 in 1000 ms for chunk ${key.slice(0, 12)}: Malformed translation response.`;
    }),
  );
  assert.deepEqual(f.calls, f.chunks, 'the worker must not add its own retry loop');
});

test('real provider retries malformed responses without caching incomplete translations', async (t) => {
  const f = await fixture(t);
  const attempts = new Map();
  const logs = [];
  const translator = createTranslationProvider({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:12345/v1',
    model: 'offline-model',
    interval: 0,
    retries: 1,
    retryDelay: 1,
    fetchImpl: async (_url, request) => {
      const text = JSON.parse(request.body).messages[1].content;
      const attempt = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, attempt);
      const config = { version: 1, provider: translator.identity, maxChars: 2000 };
      const key = hash(JSON.stringify({ config, text }));
      await assert.rejects(f.text(`cache/${key}.json`), { code: 'ENOENT' });
      assert.equal((await f.json('manifest.json')).complete, false);
      if (attempt === 1) return new Response('{');
      return Response.json({
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: translated(text) } },
        ],
      });
    },
  });
  await f.run({ translator, concurrency: 1, log: (message) => logs.push(message) });
  assert.deepEqual(
    [...attempts],
    f.chunks.map((text) => [text, 2]),
  );
  assert.equal(logs.filter((message) => message.includes('Retry 1/1 in 1 ms')).length, 7);
  assert.equal((await f.json('manifest.json')).complete, true);
  const caches = await snapshot(join(f.output, 'cache'));
  assert.equal(Object.keys(caches).length, 7);
  assert.deepEqual(
    Object.values(caches)
      .map((value) => JSON.parse(value).text)
      .sort(),
    f.chunks.map(translated).sort(),
  );
});

test(
  'CLI and real provider grow truncated HTTP requests, cache only complete chunks, and resume across ceilings',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const calls = [];
    const serverErrors = [];
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, undefined);
        const buffers = [];
        for await (const buffer of request) buffers.push(buffer);
        const payload = JSON.parse(Buffer.concat(buffers).toString('utf8'));
        const text = payload.messages[1].content;
        calls.push({ text, budget: payload.max_tokens });
        const config = (await f.json('manifest.json')).config;
        const key = hash(JSON.stringify({ config, text }));
        await assert.rejects(f.text(`cache/${key}.json`), { code: 'ENOENT' });
        const truncated = payload.max_tokens < 8192;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: truncated ? 'length' : 'stop',
                message: { role: 'assistant', content: truncated ? 'PARTIAL' : translated(text) },
              },
            ],
          }),
        );
      } catch (error) {
        serverErrors.push(error);
        response.statusCode = 500;
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const run = (options) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL('./translate-syosetu.mjs', import.meta.url).pathname,
            f.source,
            '--output',
            f.output,
            '--provider',
            'openai',
            '--model',
            'offline-model',
            '--base-url',
            `http://127.0.0.1:${server.address().port}/v1`,
            '--interval',
            '0',
            '--retry-delay',
            '1',
            '--retries',
            '5',
            ...options,
          ],
          {
            env: { ...process.env, TRANSLATE_API_KEY: '' },
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    const failed = await run(['--max-output-tokens-limit', '4096', '--concurrency', '1']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /length|truncated/i);
    assert.deepEqual(
      calls,
      [{ text: f.chunks[0], budget: 4096 }],
      'fixed ceiling is terminal without pipeline retries',
    );
    assert.equal((await f.json('manifest.json')).complete, false);
    assert.deepEqual(await readdir(join(f.output, 'cache')), []);
    await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
    const initialConfig = (await f.json('manifest.json')).config;

    calls.length = 0;
    const success = await run(['--max-output-tokens-limit', '8192', '--concurrency', '3']);
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(serverErrors, []);
    for (const text of f.chunks) {
      assert.deepEqual(
        calls.filter((call) => call.text === text).map((call) => call.budget),
        [4096, 8192],
      );
    }
    assert.equal(calls.length, 14);
    const retries = success.stdout.split('\n').filter((line) => line.includes('] Retry '));
    assert.equal(retries.length, 7);
    for (const line of retries) {
      assert.match(line, /Retry 1\/5/);
      assert.match(line, /4096/);
      assert.match(line, /8192/);
      assert.match(line, /limit|ceiling/i);
    }
    assert.equal((await f.json('manifest.json')).complete, true);
    assert.deepEqual((await f.json('manifest.json')).config, initialConfig);
    assert.equal(initialConfig.provider.maxOutputTokens, 4096);
    assert.equal(Object.hasOwn(initialConfig.provider, 'maxOutputTokensLimit'), false);
    const caches = await snapshot(join(f.output, 'cache'));
    assert.deepEqual(
      Object.keys(caches).sort(),
      f.chunks
        .map((text) => `${hash(JSON.stringify({ config: initialConfig, text }))}.json`)
        .sort(),
    );
    assert.deepEqual(
      Object.values(caches)
        .map((value) => JSON.parse(value).text)
        .sort(),
      f.chunks.map(translated).sort(),
    );
    for (const options of [
      [],
      ['--max-output-tokens-limit', '4096'],
      ['--max-output-tokens-limit', '65536'],
    ]) {
      const resumed = await run(options);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.match(resumed.stdout, /0 pending requests.*7 cached chunks/);
      assert.equal(calls.length, 14, 'changing only the ceiling must reuse all valid caches');
      assert.deepEqual(await snapshot(join(f.output, 'cache')), caches);
    }
    calls.length = 0;
    const largerInitial = await run(['--max-output-tokens', '65536']);
    assert.equal(largerInitial.status, 0, largerInitial.stderr);
    assert.match(largerInitial.stdout, /7 pending requests.*0 cached chunks/);
    assert.deepEqual(
      calls,
      f.chunks.map((text) => ({ text, budget: 65536 })),
      'an omitted ceiling must be derived by the provider, even above 32768',
    );
    assert.equal((await f.json('manifest.json')).config.provider.maxOutputTokens, 65536);
    assert.deepEqual(serverErrors, []);
  },
);

test(
  'CLI repairs partial Japanese through local HTTP retries without budget growth or dry-run writes',
  { timeout: 30000 },
  async (t) => {
    const f = await japaneseFixture(t);
    const calls = [];
    const serverErrors = [];
    const source = f.chunks[4];
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, undefined);
        const buffers = [];
        for await (const buffer of request) buffers.push(buffer);
        const payload = JSON.parse(Buffer.concat(buffers).toString('utf8'));
        const text = payload.messages[1].content;
        calls.push({ text, budget: payload.max_tokens });
        assert.equal(text, source);
        const key = cacheKey(f.translator.identity, text);
        await assert.rejects(f.text(`cache/${key}.json`), { code: 'ENOENT' });
        assert.equal((await f.json('manifest.json')).complete, false);
        await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: calls.length === 1 ? f.partial : f.translations.get(text),
                },
              },
            ],
          }),
        );
      } catch (error) {
        serverErrors.push(error);
        response.statusCode = 500;
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    f.translator.identity = offlineProvider({ baseUrl }).identity;
    const oldIdentity = { ...f.translator.identity, promptVersion: '1' };
    await seedBook(f, oldIdentity);
    await seedCache(f, oldIdentity, source, f.partial);
    const run = (extra = []) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL('./translate-syosetu.mjs', import.meta.url).pathname,
            f.source,
            '--output',
            f.output,
            '--model',
            'offline-model',
            '--base-url',
            baseUrl,
            '--interval',
            '0',
            '--retry-delay',
            '1',
            '--retries',
            '1',
            '--concurrency',
            '1',
            ...extra,
          ],
          {
            env: { ...process.env, TRANSLATE_API_KEY: '' },
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const original = await snapshot(f.root);
    const plan = await run(['--dry-run']);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /1 pending requests.*6 cached chunks/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await snapshot(f.root), original);
    const result = await run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(calls, [
      { text: source, budget: 4096 },
      { text: source, budget: 4096 },
    ]);
    assert.match(result.stdout, /Retry 1\/1.*Translation contains untranslated Japanese text\./);
    assert.ok(!result.stdout.includes(f.partial));
    assert.equal((await f.json('manifest.json')).complete, true);
    for (const text of f.chunks) {
      const key = cacheKey(f.translator.identity, text);
      assert.equal((await f.json(`cache/${key}.json`)).text, f.translations.get(text));
    }
    const complete = await snapshot(f.root);
    const cachedPlan = await run(['--dry-run']);
    assert.equal(cachedPlan.status, 0, cachedPlan.stderr);
    assert.match(cachedPlan.stdout, /0 pending requests, 0 source characters, 7 cached chunks/);
    assert.equal(calls.length, 2);
    assert.deepEqual(await snapshot(f.root), complete);
    const resumed = await run();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /0 pending requests.*7 cached chunks/);
    assert.equal(calls.length, 2);
    assert.equal((await f.json('chapters/1.json')).body.text, f.translations.get(source));
    for (const [path, contents] of Object.entries(original)) {
      if (path.startsWith('output/cache/')) {
        assert.equal(await readFile(join(f.root, path), 'utf8'), contents);
      }
    }
  },
);

test('real provider exhaustion leaves complete:false and preserves successes for resume', async (t) => {
  const f = await fixture(t);
  const calls = [];
  let fail = true;
  const options = {
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:12345/v1',
    model: 'offline-model',
    interval: 0,
    retries: 2,
    retryDelay: 1,
    fetchImpl: async (_url, request) => {
      const text = JSON.parse(request.body).messages[1].content;
      calls.push(text);
      if (fail && text === f.chunks[2]) {
        return Response.json({ choices: [] });
      }
      return Response.json({
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: translated(text) } },
        ],
      });
    },
  };
  const translator = createTranslationProvider(options);
  await assert.rejects(f.run({ translator, concurrency: 1 }), /malformed/i);
  assert.deepEqual(calls, [...f.chunks.slice(0, 2), ...Array(3).fill(f.chunks[2])]);
  assert.equal((await f.json('manifest.json')).complete, false);
  const caches = await snapshot(join(f.output, 'cache'));
  assert.equal(Object.keys(caches).length, 2);
  await assert.rejects(f.text('novel.txt'), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(f.output, 'chapters')), []);
  fail = false;
  calls.length = 0;
  const resumed = createTranslationProvider({ ...options, retries: 0, retryDelay: 10 });
  assert.deepEqual(resumed.identity, translator.identity);
  const stats = await f.run({ translator: resumed, concurrency: 1 });
  assert.equal(stats.cachedChunks, 2);
  assert.deepEqual(calls, f.chunks.slice(2));
  for (const [file, contents] of Object.entries(caches))
    assert.equal(await f.text(`cache/${file}`), contents);
  assert.equal((await f.json('manifest.json')).complete, true);
});

test('notes can be enabled from cache and refresh retranslates every unique chunk', async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.equal((await f.json('chapters/1.json')).preface.text, '');
  assert.doesNotMatch(await f.text('novel.txt'), /Before|After/);
  f.calls.length = 0;
  await f.run({ notes: true });
  assert.deepEqual(f.calls, ['Before', 'After']);
  assert.equal((await f.json('chapters/2.json')).afterword.text, translated('After'));
  f.calls.length = 0;
  const stats = await f.run({ notes: true, refresh: true });
  assert.equal(stats.cachedChunks, 0);
  assert.equal(f.calls.length, 9);
  f.calls.length = 0;
  await f.run({ notes: false });
  assert.deepEqual(f.calls, []);
  assert.equal((await f.json('chapters/1.json')).afterword.text, '');
});

test('chapter URLs cannot escape the novel or encode filesystem traversal', async (t) => {
  const f = await fixture(t);
  for (const url of [
    'https://example.test/1/',
    `${ROOT}../1/`,
    `${ROOT}%2e%2e/`,
    `${ROOT}0/`,
    `${ROOT}1/?x=1`,
    ROOT,
  ]) {
    f.manifest.chapters[1].url = url;
    await f.save();
    await assert.rejects(f.run(), /outside this novel|mixed short-story/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(readdir(f.output), { code: 'ENOENT' });
  }
});

test('output cannot overlap source, including symlink aliases; default output is allowed', async (t) => {
  const f = await fixture(t);
  await symlink(f.source, join(f.root, 'alias'), 'dir');
  const original = await snapshot(f.source);
  for (const output of [
    f.source,
    f.root,
    join(f.source, 'chapters'),
    join(f.source, 'new'),
    join(f.root, 'alias', 'new'),
  ]) {
    await assert.rejects(f.run({ output }), /must not overlap/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await snapshot(f.source), original);
  }
  const stats = await f.run({ output: undefined });
  assert.equal(stats.directory, join(f.source, 'translations', 'zh-Hans'));
  assert.equal((await readJson(join(stats.directory, 'manifest.json'))).complete, true);
});

test('an existing output chapters symlink cannot redirect writes into source chapters', async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  await symlink(join(f.source, 'chapters'), join(f.output, 'chapters'), 'dir');
  const original = await snapshot(f.source);
  const error = await f.run().then(
    () => null,
    (error) => error,
  );
  assert.deepEqual(
    await snapshot(f.source),
    original,
    'output symlinks must not overwrite crawler source files',
  );
  assert.ok(error, 'unsafe output must be rejected');
  assert.match(error.message, /overlap|symlink|source|unsafe/i);
  assert.deepEqual(f.calls, []);
});

test('batchTranslate scans a root, skips incomplete/non-books, and translates complete books one by one', async (t) => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'turblog-batch-'));
  t.after(() => rm(scanRoot, { recursive: true, force: true }));
  const a = await fixture(t);
  const b = await fixture(t);
  const c = await fixture(t);
  // One complete book plus a second that is still being crawled.
  await mkdir(join(scanRoot, 'complete1'));
  await mkdir(join(scanRoot, 'complete2'));
  await mkdir(join(scanRoot, 'incomplete1'));
  await mkdir(join(scanRoot, 'not-a-book'));
  await cp(a.source, join(scanRoot, 'complete1'), { recursive: true });
  await cp(b.source, join(scanRoot, 'complete2'), { recursive: true });
  c.manifest.complete = false;
  await c.save();
  await cp(c.source, join(scanRoot, 'incomplete1'), { recursive: true });
  const warns = [];
  const logs = [];
  const summary = await batchTranslate(scanRoot, {
    translator: a.translator,
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.translated, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(
    summary.results.map((r) => r.book),
    ['complete1', 'complete2'],
  );
  for (const book of ['complete1', 'complete2']) {
    const manifest = await readJson(
      join(scanRoot, book, 'translations', 'zh-Hans', 'manifest.json'),
    );
    assert.equal(manifest.complete, true);
  }
  assert.ok(warns.some((m) => m.includes('incomplete1') && m.includes('crawling unfinished')));
  assert.ok(warns.some((m) => m.includes('not-a-book') && m.includes('no manifest.json')));
  assert.ok(logs.some((m) => m.includes('2 translated')));
  await assert.rejects(readdir(join(scanRoot, 'incomplete1', 'translations')), { code: 'ENOENT' });
});

test('batchTranslate continues past a failing book and reports it as failed', async (t) => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'turblog-batch-fail-'));
  t.after(() => rm(scanRoot, { recursive: true, force: true }));
  const a = await fixture(t);
  const b = await fixture(t);
  await mkdir(join(scanRoot, 'good'));
  await mkdir(join(scanRoot, 'broken'));
  await cp(a.source, join(scanRoot, 'good'), { recursive: true });
  // Break the second book so its chapters fail validation.
  b.manifest.chapters[1] = b.manifest.chapters[0];
  await b.save();
  await cp(b.source, join(scanRoot, 'broken'), { recursive: true });
  const logs = [];
  const summary = await batchTranslate(scanRoot, {
    translator: a.translator,
    log: (message) => logs.push(message),
    warn: () => {},
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.translated, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results.find((r) => r.book === 'good').ok, true);
  assert.equal(summary.results.find((r) => r.book === 'broken').ok, false);
  assert.ok(logs.some((m) => m.includes('1 translated, 1 failed')));
});

test('single-book default concurrency is bounded and out-of-order chunks export in source order', async (t) => {
  const f = await fixture(t);
  const initial = Array.from({ length: 4 }, () => Promise.withResolvers());
  const started = Promise.withResolvers();
  const fifth = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  let count = 0;
  f.translator.translate = async (text) => {
    const index = count++;
    active++;
    peak = Math.max(peak, active);
    if (count === 4) started.resolve();
    if (index === 4) fifth.resolve();
    if (index < 4) await initial[index].promise;
    active--;
    return translated(text);
  };
  const result = f.run();
  await started.promise;
  assert.equal(count, 4);
  initial[3].resolve();
  await fifth.promise;
  for (const index of [2, 1, 0]) initial[index].resolve();
  await result;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    (await f.json('manifest.json')).chapters.map((chapter) => chapter.file),
    ['chapters/1.json', 'chapters/2.json'],
  );
  assert.equal((await f.json('chapters/1.json')).body.text, translated(f.chapters[0].body.text));
  const text = await f.text('novel.txt');
  assert.ok(
    text.indexOf(translated(f.chapters[0].body.text)) <
      text.indexOf(translated(f.chapters[1].body.text)),
  );
  const resumed = await f.run({ concurrency: 1 });
  assert.equal(resumed.pendingRequests, 0, 'concurrency must not invalidate existing caches');
  assert.equal(count, 7);
});

test('single-book workers reach concurrent requests through the real provider adapter', async (t) => {
  const f = await fixture(t);
  let active = 0;
  let peak = 0;
  const translator = createTranslationProvider({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:12345/v1',
    model: 'offline-model',
    interval: 0,
    fetchImpl: async (_url, request) => {
      active++;
      peak = Math.max(peak, active);
      const text = JSON.parse(request.body).messages[1].content;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: 'stop', message: { role: 'assistant', content: translated(text) } },
          ],
        }),
      );
    },
  });
  await f.run({ translator, concurrency: 3 });
  assert.equal(peak, 3, 'provider must not serialize complete responses');
  assert.equal(active, 0);
  assert.equal((await f.json('manifest.json')).complete, true);
  assert.equal((await f.json('chapters/2.json')).body.text, translated(f.chapters[1].body.text));
});

test('failed concurrent chunks stop dispatch and drain successful work before returning', async (t) => {
  const f = await fixture(t);
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers());
  const started = Promise.withResolvers();
  let settled = false;
  f.translator.translate = async (text) => {
    const index = f.calls.push(text) - 1;
    if (f.calls.length === 3) started.resolve();
    await gates[index].promise;
    return translated(text);
  };
  const result = f.run({ concurrency: 3 }).then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await started.promise;
  gates[0].reject(new Error('failed chunk'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'must wait for other in-flight chunks');
  assert.equal(f.calls.length, 3);
  gates[1].resolve();
  gates[2].resolve();
  assert.match((await result).message, /failed chunk/);
  assert.equal((await f.json('manifest.json')).complete, false);
  assert.equal((await readdir(join(f.output, 'cache'))).length, 2);
  assert.equal(f.calls.length, 3, 'failed run must not dispatch remaining chunks');
  f.translator.translate = async (text) => translated(text);
  assert.equal((await f.run({ concurrency: 2 })).pendingRequests, 5);
});

test('single-book concurrency validation happens before reads and dry-run work', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, 33, '4']) {
    await assert.rejects(
      translateNovel('/nonexistent', { concurrency, dryRun: true }),
      /positive integer/,
    );
  }
});

test('batchTranslate with createTranslator overlaps chunks but never books', async (t) => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'turblog-batch-par-'));
  t.after(() => rm(scanRoot, { recursive: true, force: true }));
  const a = await fixture(t);
  const b = await fixture(t);
  await mkdir(join(scanRoot, 'one'));
  await mkdir(join(scanRoot, 'two'));
  await cp(a.source, join(scanRoot, 'one'), { recursive: true });
  await cp(b.source, join(scanRoot, 'two'), { recursive: true });
  let inFlight = 0;
  let peak = 0;
  const identity = {
    provider: 'mock',
    source: 'ja',
    target: 'zh-Hans',
    model: 'test',
    promptVersion: 1,
  };
  let factories = 0;
  const starts = [];
  let currentBook;
  const createTranslator = () => {
    factories++;
    return {
      identity,
      translate: async (text) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (currentBook === 'two') {
          assert.equal(
            (await readJson(join(scanRoot, 'one/translations/zh-Hans/manifest.json'))).complete,
            true,
          );
        }
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return `T(${text})`;
      },
    };
  };
  const summary = await batchTranslate(scanRoot, {
    createTranslator,
    concurrency: 2,
    log: (message) => {
      const match = message.match(/^=== \[\d+\/\d+\] (\w+) ===$/);
      if (match) {
        assert.equal(inFlight, 0, 'previous book must finish before starting another');
        currentBook = match[1];
        starts.push(currentBook);
      }
    },
    warn: () => {},
  });
  assert.equal(summary.translated, 2);
  assert.equal(summary.failed, 0);
  assert.equal(peak, 2, 'concurrency counts chunks within one book');
  assert.equal(factories, 1, 'reuse provider pacing across books');
  assert.deepEqual(starts, ['one', 'two']);
});

test('batchTranslate supports an injected translator that chooses to serialize its own requests', async (t) => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'turblog-batch-serial-'));
  t.after(() => rm(scanRoot, { recursive: true, force: true }));
  const a = await fixture(t);
  const b = await fixture(t);
  await mkdir(join(scanRoot, 'one'));
  await mkdir(join(scanRoot, 'two'));
  await cp(a.source, join(scanRoot, 'one'), { recursive: true });
  await cp(b.source, join(scanRoot, 'two'), { recursive: true });
  let inFlight = 0;
  let peak = 0;
  // An optional external translator may still impose its own serial request queue.
  let queue = Promise.resolve();
  const translator = {
    identity: {
      provider: 'mock',
      source: 'ja',
      target: 'zh-Hans',
      model: 'test',
      promptVersion: 1,
    },
    translate(text) {
      const run = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return `T(${text})`;
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
  };
  const summary = await batchTranslate(scanRoot, {
    translator,
    concurrency: 4,
    log: () => {},
    warn: () => {},
  });
  assert.equal(summary.translated, 2);
  assert.equal(peak, 1, 'a shared translator keeps requests serialized');
});

test('batchTranslate drains a failed book before continuing to the next book', async (t) => {
  const f = await fixture(t);
  const scanRoot = join(f.root, 'batch');
  await cp(f.source, join(scanRoot, 'one'), { recursive: true });
  await cp(f.source, join(scanRoot, 'two'), { recursive: true });
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers());
  const started = Promise.withResolvers();
  const starts = [];
  let currentBook;
  let firstCalls = 0;
  const summaryPromise = batchTranslate(scanRoot, {
    concurrency: 3,
    translator: {
      identity: f.translator.identity,
      translate: async (text) => {
        if (currentBook === 'one') {
          const index = firstCalls++;
          if (firstCalls === 3) started.resolve();
          await gates[index].promise;
        } else {
          assert.equal((await readdir(join(scanRoot, 'one/translations/zh-Hans/cache'))).length, 2);
          assert.equal(
            (await readJson(join(scanRoot, 'one/translations/zh-Hans/manifest.json'))).complete,
            false,
          );
        }
        return translated(text);
      },
    },
    log: (message) => {
      const match = message.match(/^=== \[\d+\/\d+\] (\w+) ===$/);
      if (match) {
        currentBook = match[1];
        starts.push(currentBook);
      }
    },
    warn: () => {},
  });
  await started.promise;
  gates[0].reject(new Error('failed chunk'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['one']);
  gates[1].resolve();
  gates[2].resolve();
  const summary = await summaryPromise;
  assert.equal(summary.failed, 1);
  assert.equal(summary.translated, 1);
  assert.equal(firstCalls, 3);
  assert.deepEqual(starts, ['one', 'two']);
});

test('batchTranslate rejects one shared output directory before writing any book', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    batchTranslate(f.root, { translator: f.translator, output: f.output }),
    /--output is only supported for a single book/,
  );
  await assert.rejects(readdir(f.output), { code: 'ENOENT' });
});

test('batchTranslate rejects invalid concurrency values', async (t) => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'turblog-batch-conc-'));
  t.after(() => rm(scanRoot, { recursive: true, force: true }));
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, 33]) {
    await assert.rejects(
      batchTranslate(scanRoot, {
        translator: { identity: {}, translate: async () => '' },
        concurrency,
      }),
      /positive integer/,
    );
  }
});

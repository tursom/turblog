// @ts-nocheck
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { importTranslatedBook } from './import-translated-book.mjs';

const SOURCE = 'https://novel18.syosetu.com/n1234ab/';
const SLUG = 'syosetu-n1234ab-zh-hans';
const SECRET = 'dummy-secret-must-not-be-exported';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const putJson = (path, value) => writeFile(path, JSON.stringify(value));
const section = (text) => ({ text, markdown: `<script>${SECRET}</script>` });
before(() =>
  mock.method(globalThis, 'fetch', () => {
    throw new Error('Network forbidden');
  }),
);
after(() => mock.restoreAll());

async function snapshot(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result[`${entry.name}/`] = 'directory';
      for (const [name, value] of Object.entries(await snapshot(path)))
        result[`${entry.name}/${name}`] = value;
    } else
      result[entry.name] = entry.isSymbolicLink()
        ? { link: await readlink(path) }
        : await readFile(path, 'utf8');
  }
  return result;
}

// The emitter uses one JSON value per YAML field; anchor the block to avoid parsing body text.
function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(block, 'frontmatter must start the file');
  const fields = {};
  for (const line of block[1].split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line);
    assert.ok(match, `JSON-valued frontmatter field: ${line}`);
    assert.ok(!Object.hasOwn(fields, match[1]), 'no duplicate fields');
    fields[match[1]] = JSON.parse(match[2]);
  }
  return { fields, body: text.slice(block[0].length) };
}

async function fixture(t, ids = [7, 2, 9]) {
  const root = await mkdtemp(join(tmpdir(), 'turblog-import-translation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'translation');
  const booksRoot = join(root, 'books');
  const directory = join(booksRoot, SLUG);
  await mkdir(join(input, 'chapters'), { recursive: true });
  const chapters = ids.map((id, index) => ({
    version: 1,
    machineTranslated: true,
    sourceUrl: `${SOURCE}${id}/`,
    title: `Chapter ${id}`,
    group: index < 2 ? 'Volume One' : 'Volume Two',
    body: section(`Body ${id}`),
    preface: section('Before'),
    afterword: section('After'),
    sourceRevision: SECRET,
    config: { apiKey: SECRET },
  }));
  const manifest = {
    version: 1,
    complete: true,
    machineTranslated: true,
    sourceUrl: SOURCE,
    language: 'zh-Hans',
    title: 'Book: "quoted"\nprivate: false',
    author: 'Writer',
    summary: 'Summary',
    private: false,
    config: { apiKey: SECRET, endpoint: `https://${SECRET}.invalid` },
    chapters: chapters.map(({ title, group, sourceUrl }, index) => ({
      file: `chapters/${ids[index]}.json`,
      title,
      group,
      sourceUrl,
    })),
  };
  const save = async () => {
    await putJson(join(input, 'manifest.json'), manifest);
    for (const [index, chapter] of chapters.entries())
      await putJson(join(input, 'chapters', `${ids[index]}.json`), chapter);
  };
  await save();
  await writeFile(join(input, '.env'), `API_KEY=${SECRET}`);
  await putJson(join(input, 'config.json'), { key: SECRET });
  const logs = [];
  return {
    root,
    input,
    booksRoot,
    directory,
    manifest,
    chapters,
    save,
    logs,
    run: (options = {}) =>
      importTranslatedBook(input, { booksRoot, log: (line) => logs.push(line), ...options }),
  };
}

async function verifyReceipt(f) {
  const files = await snapshot(f.directory);
  const receipt = JSON.parse(files['import-receipt.json']);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.generator, 'syosetu-private-translation');
  assert.equal(receipt.slug, SLUG);
  assert.equal(receipt.sourceUrl, SOURCE);
  assert.equal(receipt.language, 'zh-hans');
  assert.ok(Number.isFinite(Date.parse(receipt.importedAt)));
  const content = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.endsWith('.md')),
  );
  assert.deepEqual(
    receipt.files,
    Object.fromEntries(Object.entries(content).map(([path, text]) => [path, hash(text)])),
  );
  assert.deepEqual(
    Object.keys(files).sort(),
    [...Object.keys(content), 'chapters/', 'import-receipt.json'].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(files),
    new RegExp(`${SECRET}|apiKey|endpoint|sourceRevision`),
  );
  return content;
}

async function refusesWithoutWrites(f, pattern = /./) {
  const before = await snapshot(f.root);
  await assert.rejects(f.run(), pattern);
  assert.deepEqual(await snapshot(f.root), before);
}

test('private book schema, manifest order, grouping, source metadata and receipt', async (t) => {
  const f = await fixture(t);
  const input = await snapshot(f.input);
  assert.deepEqual(await f.run({ private: false }), {
    slug: SLUG,
    directory: f.directory,
    chapterCount: 3,
    private: true,
    path: `/books/${SLUG}/`,
  });
  const files = await verifyReceipt(f);
  const book = frontmatter(files['book.md']).fields;
  assert.deepEqual(
    Object.keys(book).sort(),
    [
      'slug',
      'private',
      'title',
      'author',
      'category',
      'groupSlug',
      'groupTitle',
      'groupType',
      'groupOrder',
      'seriesOrder',
      'translator',
      'language',
      'editionLabel',
      'summary',
      'sourceUrl',
      'sourceName',
      'rightsNotice',
      'cover',
      'chapterCount',
      'volumeCount',
    ].sort(),
  );
  assert.equal(book.private, true);
  for (const key of ['title', 'author', 'summary', 'language', 'sourceUrl'])
    assert.equal(book[key], f.manifest[key]);
  assert.equal(book.slug, SLUG);
  assert.equal(book.groupSlug, SLUG);
  assert.equal(book.groupTitle, book.title);
  assert.equal(book.groupType, 'editions');
  assert.equal(book.category, 'works');
  assert.equal(book.cover, null);
  assert.equal(book.chapterCount, 3);
  assert.equal(book.volumeCount, 2);
  for (const key of ['groupOrder', 'seriesOrder'])
    assert.ok(Number.isInteger(book[key]) && book[key] > 0);
  for (const key of ['translator', 'editionLabel', 'rightsNotice', 'sourceName'])
    assert.ok(book[key].trim());
  for (const [index, id] of [7, 2, 9].entries()) {
    const { fields, body } = frontmatter(files[`chapters/000${index + 1}-episode-${id}.md`]);
    assert.deepEqual(fields, {
      bookSlug: SLUG,
      chapterNumber: index + 1,
      slug: `episode-${id}`,
      title: `Chapter ${id}`,
      sourcePath: `${SOURCE}${id}/`,
      unitType: 'chapter',
      volumeNumber: index < 2 ? 1 : 2,
      volumeTitle: index < 2 ? 'Volume One' : 'Volume Two',
      volumeUnitNumber: index < 2 ? index + 1 : 1,
    });
    assert.match(body, new RegExp(`Before[\\s\\S]*Body ${id}[\\s\\S]*After`));
    assert.equal((body.match(/^## /gm) || []).length, 2);
  }
  assert.deepEqual(await snapshot(f.input), input);
  assert.match(f.logs.join('\n'), /Imported 3 chapters as a private book/);
});

test('plaintext is escaped, markdown representations ignored, and empty notes omitted', async (t) => {
  const f = await fixture(t);
  const payload =
    '<script>alert(1)</script> & <img src=x onerror=alert(1)>\n**bold**\n[click](javascript:alert(1))\n![image](https://example.invalid/x)\n```html\n<div>raw</div>\n```\n> quote';
  f.chapters[0].body.text = payload;
  f.chapters[0].preface.text = '<b>before</b>';
  f.chapters[0].afterword.text = '*after*';
  f.chapters[1].preface.text = ' \n';
  f.chapters[1].afterword.text = '';
  await f.save();
  await f.run();
  const files = await verifyReceipt(f);
  const { body } = frontmatter(files['chapters/0001-episode-7.md']);
  assert.doesNotMatch(
    body,
    /<\/?(?:script|img|div|b)\b|\*\*bold\*\*|(?<!\\)\[click\]|(?<!\\)!\[image\]|^```|^> quote/m,
  );
  for (const escaped of [
    '&lt;script&gt;',
    '&amp;',
    '\\*\\*bold\\*\\*',
    '\\[click\\]',
    '\\[image\\]',
    '\\`\\`\\`',
    '&lt;b&gt;before&lt;\\/b&gt;',
    '\\*after\\*',
  ])
    assert.ok(body.includes(escaped), escaped);
  assert.equal(frontmatter(files['chapters/0002-episode-2.md']).body.trim(), 'Body 2');
});

test('multiline plaintext cannot inject Markdown blocks through body or notes', async (t) => {
  for (const name of ['body', 'preface', 'afterword'])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.chapters[0][name].text =
        'Ordinary text\n\n# injected heading\n\n- injected list\n\n1. injected ordered list\n\n---';
      await f.save();
      await f.run();
      const { body } = frontmatter(
        await readFile(join(f.directory, 'chapters/0001-episode-7.md'), 'utf8'),
      );
      assert.doesNotMatch(
        body,
        /^# injected heading$|^- injected list$|^1\. injected ordered list$|^---$/m,
      );
    });
});

test('ungrouped runs remain ordered, with nonempty summary and author fallbacks', async (t) => {
  const f = await fixture(t, [8, 3, 12, 4, 6]);
  f.manifest.summary = ' \n';
  f.manifest.author = ' ';
  for (const [index, group] of ['', 'A', '', 'A', 'A'].entries()) {
    f.manifest.chapters[index].group = f.chapters[index].group = group;
  }
  await f.save();
  await f.run();
  const files = await verifyReceipt(f);
  const book = frontmatter(files['book.md']).fields;
  assert.ok(book.summary.trim() && book.summary.includes(f.manifest.title));
  assert.ok(book.author.trim());
  assert.equal(book.volumeCount, 3);
  const chapters = Object.keys(files)
    .filter((path) => path.startsWith('chapters/'))
    .sort()
    .map((path) => frontmatter(files[path]).fields);
  assert.deepEqual(
    chapters.map((c) => c.volumeNumber),
    [undefined, 1, 2, 3, 3],
  );
  assert.deepEqual(
    chapters.map((c) => c.volumeUnitNumber),
    [undefined, 1, 1, 1, 2],
  );
  assert.ok(chapters[2].volumeTitle.trim());
  assert.equal(chapters[0].volumeTitle, undefined);
});

test('slug depends only on ncode and case-normalized language; oneshots work', async (t) => {
  const f = await fixture(t, ['oneshot']);
  f.manifest.chapters[0].sourceUrl = f.chapters[0].sourceUrl = SOURCE;
  await f.save();
  assert.equal((await f.run()).slug, SLUG);
  f.manifest.title = 'Renamed';
  f.manifest.language = 'ZH-hANS';
  await f.save();
  assert.equal((await f.run()).slug, SLUG);
  const chapter = frontmatter(
    await readFile(join(f.directory, 'chapters/0001-oneshot.md'), 'utf8'),
  ).fields;
  assert.equal(chapter.slug, 'oneshot');
  assert.equal(chapter.sourcePath, SOURCE);
  f.manifest.language = 'en';
  await f.save();
  assert.equal((await f.run()).slug, 'syosetu-n1234ab-en');
  f.manifest.sourceUrl =
    f.manifest.chapters[0].sourceUrl =
    f.chapters[0].sourceUrl =
      SOURCE.replace('n1234ab', 'n9999zz');
  await f.save();
  assert.equal((await f.run()).slug, 'syosetu-n9999zz-en');
  assert.deepEqual(
    (await readdir(f.booksRoot)).sort(),
    [SLUG, 'syosetu-n1234ab-en', 'syosetu-n9999zz-en'].sort(),
  );
});

test('dry run validates and reports without creating or changing output', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  assert.equal((await f.run({ dryRun: true })).private, true);
  assert.deepEqual(await snapshot(f.root), before);
  assert.match(f.logs.join('\n'), /Would import 3 chapters/);
  await f.run();
  const imported = await snapshot(f.root);
  await f.run({ dryRun: true });
  assert.deepEqual(await snapshot(f.root), imported);
  f.manifest.complete = false;
  await f.save();
  const invalid = await snapshot(f.root);
  await assert.rejects(f.run({ dryRun: true }), /complete/);
  assert.deepEqual(await snapshot(f.root), invalid);
});

test('invalid translations reject before any writes, including failures in the last chapter', async (t) => {
  const cases = [
    [
      'incomplete',
      (f) => {
        f.manifest.complete = false;
      },
    ],
    [
      'raw crawler',
      (f) => {
        delete f.manifest.machineTranslated;
        f.manifest.url = SOURCE;
      },
    ],
    [
      'version',
      (f) => {
        f.manifest.version = 2;
      },
    ],
    [
      'no chapters',
      (f) => {
        f.manifest.chapters = [];
      },
    ],
    [
      'missing summary',
      (f) => {
        delete f.manifest.summary;
      },
    ],
    [
      'blank title',
      (f) => {
        f.manifest.title = ' ';
      },
    ],
    [
      'bad language',
      (f) => {
        f.manifest.language = '../en';
      },
    ],
    [
      'bad source',
      (f) => {
        f.manifest.sourceUrl = 'https://example.invalid/n1234ab/';
      },
    ],
    [
      'noncanonical source',
      (f) => {
        f.manifest.sourceUrl += '?query=1';
      },
    ],
    [
      'foreign chapter',
      (f) => {
        f.manifest.chapters[2].sourceUrl = SOURCE.replace('n1234ab', 'n9999zz') + '9/';
      },
    ],
    [
      'unsafe path',
      (f) => {
        f.manifest.chapters[2].file = 'chapters/../../outside.json';
      },
    ],
    [
      'absolute path',
      (f) => {
        f.manifest.chapters[2].file = join(f.input, 'chapters/9.json');
      },
    ],
    [
      'duplicate',
      (f) => {
        f.manifest.chapters[2] = f.manifest.chapters[0];
      },
    ],
    [
      'missing body',
      (f) => {
        delete f.chapters[2].body;
      },
    ],
    [
      'blank body',
      (f) => {
        f.chapters[2].body.text = ' \n';
      },
    ],
    [
      'missing notes',
      (f) => {
        delete f.chapters[2].afterword;
      },
    ],
    [
      'raw chapter',
      (f) => {
        delete f.chapters[2].machineTranslated;
      },
    ],
    [
      'mismatched title',
      (f) => {
        f.chapters[2].title = 'Stale';
      },
    ],
    [
      'mismatched group',
      (f) => {
        f.chapters[2].group = 'Stale';
      },
    ],
    [
      'mismatched source',
      (f) => {
        f.chapters[2].sourceUrl = `${SOURCE}99/`;
      },
    ],
    ...['manifest.json', 'chapters/9.json'].map((path) => [
      `malformed ${path}`,
      () => {},
      (f) => writeFile(join(f.input, path), '{'),
    ]),
    ['missing file', () => {}, (f) => rm(join(f.input, 'chapters/9.json'))],
    ...['manifest.json', 'chapters/9.json', 'chapters'].map((path) => [
      `symlink ${path}`,
      () => {},
      async (f) => {
        const target = join(f.root, 'linked-input');
        await rename(join(f.input, path), target);
        await symlink(target, join(f.input, path));
      },
    ]),
  ];
  for (const [name, change, corrupt] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      change(f);
      await f.save();
      if (corrupt) await corrupt(f);
      await refusesWithoutWrites(
        f,
        /complete|source|canonical|language|path|duplicate|JSON|symlink|ENOENT|novel18|host/i,
      );
    });
});

test('unchanged reimport and changed source replace only receipt-owned content, removing stale chapters', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.booksRoot, 'other-book'), { recursive: true });
  await writeFile(join(f.booksRoot, 'other-book/book.md'), 'Unrelated private book');
  const other = await snapshot(join(f.booksRoot, 'other-book'));
  await f.run();
  const first = await verifyReceipt(f);
  await f.run();
  assert.deepEqual(await verifyReceipt(f), first);
  f.manifest.chapters = [f.manifest.chapters[2], f.manifest.chapters[0]];
  f.chapters[2].body.text = 'Updated source translation';
  await f.save();
  await f.run();
  const updated = await verifyReceipt(f);
  assert.deepEqual(Object.keys(updated).sort(), [
    'book.md',
    'chapters/0001-episode-9.md',
    'chapters/0002-episode-7.md',
  ]);
  assert.equal(frontmatter(updated['book.md']).fields.chapterCount, 2);
  assert.match(updated['chapters/0001-episode-9.md'], /Updated source translation/);
  assert.deepEqual(await snapshot(join(f.booksRoot, 'other-book')), other);
  assert.deepEqual((await readdir(f.booksRoot)).sort(), [SLUG, 'other-book'].sort());
});

test('local edits, ownership conflicts, destination symlinks and concurrent lock preserve all files', async (t) => {
  const cases = [
    [
      'edited book',
      true,
      (f) => writeFile(join(f.directory, 'book.md'), 'Manual edit'),
      /edited locally/,
    ],
    [
      'edited chapter',
      true,
      (f) => writeFile(join(f.directory, 'chapters/0003-episode-9.md'), 'Manual edit'),
      /edited locally/,
    ],
    [
      'added file',
      true,
      (f) => writeFile(join(f.directory, 'notes.md'), 'Personal notes'),
      /added or removed/,
    ],
    [
      'removed file',
      true,
      (f) => rm(join(f.directory, 'chapters/0003-episode-9.md')),
      /added or removed/,
    ],
    ['missing receipt', true, (f) => rm(join(f.directory, 'import-receipt.json')), /not owned/],
    [
      'bad receipt JSON',
      true,
      (f) => writeFile(join(f.directory, 'import-receipt.json'), '{'),
      /not owned/,
    ],
    ...['generator', 'slug', 'sourceUrl', 'language'].map((key) => [
      `receipt ${key}`,
      true,
      async (f) => {
        const path = join(f.directory, 'import-receipt.json');
        await putJson(path, { ...(await json(path)), [key]: 'unrelated' });
      },
      /ownership/,
    ]),
    [
      'unrelated directory',
      false,
      async (f) => {
        await mkdir(f.directory);
        await writeFile(join(f.directory, 'book.md'), 'Not importer owned');
      },
      /not owned/,
    ],
    [
      'destination file',
      false,
      (f) => writeFile(f.directory, 'Conflicting file'),
      /real directory/,
    ],
    ['destination symlink', false, (f) => symlink(f.input, f.directory), /symlink/],
    [
      'output symlink',
      true,
      async (f) => {
        const path = join(f.directory, 'chapters/0003-episode-9.md');
        await rm(path);
        await symlink(join(f.input, 'chapters/9.json'), path);
      },
      /symlink/,
    ],
    ...[false, true].map((imported) => [
      `concurrent lock (${imported})`,
      imported,
      async (f) => {
        const lock = join(f.booksRoot, `.${SLUG}.import-lock`);
        await mkdir(lock);
        await writeFile(join(lock, 'owner'), 'Another importer');
      },
      /locked/,
    ]),
  ];
  for (const [name, imported, conflict, pattern] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await mkdir(f.booksRoot);
      if (imported) await f.run();
      await conflict(f);
      await refusesWithoutWrites(f, pattern);
    });
});

test('translation can import automatically while dry runs and failed translations never import', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.root, 'runtime');
  await mkdir(join(runtime, 'scripts'), { recursive: true });
  for (const name of [
    'translate-syosetu.mjs',
    'import-translated-book.mjs',
    'crawl-syosetu.mjs',
    'translation-providers.mjs',
  ]) {
    await cp(fileURLToPath(new URL(name, import.meta.url)), join(runtime, 'scripts', name));
  }
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(runtime, 'node_modules'),
    'dir',
  );
  const { translateNovel } = await import(
    pathToFileURL(join(runtime, 'scripts/translate-syosetu.mjs')).href
  );
  const input = join(f.root, 'crawl');
  await mkdir(join(input, 'chapters'), { recursive: true });
  const body = { text: 'Source body', markdown: 'Source body' };
  const entry = { url: `${SOURCE}1/`, title: 'Source chapter', group: '', revision: 'test-1' };
  await putJson(join(input, 'manifest.json'), {
    version: 1,
    complete: true,
    ncode: 'n1234ab',
    url: SOURCE,
    title: 'Source book',
    author: 'Writer',
    summary: '',
    chapters: [entry],
  });
  await putJson(join(input, 'chapters/1.json'), {
    version: 1,
    ...entry,
    body,
    preface: { text: '', markdown: '' },
    afterword: { text: '', markdown: '' },
    checksum: hash(JSON.stringify(body)),
  });
  let calls = 0;
  const translator = {
    identity: { provider: 'mock', target: 'zh-Hans' },
    translate: async (text) => {
      calls++;
      return `Translated ${text}`;
    },
  };
  const options = { translator, importBlog: true, log: () => {} };
  await translateNovel(input, { ...options, dryRun: true });
  assert.equal(calls, 0);
  await assert.rejects(readdir(join(runtime, 'src')), /ENOENT/);
  await assert.rejects(
    translateNovel(input, {
      ...options,
      translator: {
        ...translator,
        translate: async () => {
          throw new Error('Service unavailable');
        },
      },
    }),
    /Service unavailable/,
  );
  await assert.rejects(readdir(join(runtime, 'src')), /ENOENT/);
  const result = await translateNovel(input, options);
  assert.equal(result.book.private, true);
  assert.equal(result.book.directory, join(runtime, 'src/content/books', SLUG));
  assert.equal(
    frontmatter(await readFile(join(result.book.directory, 'book.md'), 'utf8')).fields.private,
    true,
  );
  const beforeResume = calls;
  await translateNovel(input, options);
  assert.equal(calls, beforeResume);
});

test('CLI --help works offline without input or output', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./import-translated-book.mjs', import.meta.url)), '--help'],
    { cwd: f.root, timeout: 10000 },
  );
  assert.match(stdout, /Usage:.*import:translation/);
  assert.match(stdout, /PRIVATE/);
  assert.match(stdout, /--dry-run/);
  assert.equal(stderr, '');
  assert.deepEqual(await snapshot(f.root), before);
});

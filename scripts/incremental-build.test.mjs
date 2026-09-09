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
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { load } from 'cheerio';
import sharp from 'sharp';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const postPath = 'posts/alpha/index.html';
const siblingPostPath = 'posts/beta/index.html';
const bookPath = 'books/fixture-book/index.html';
const firstPath = 'books/fixture-book/first/index.html';
const secondPath = 'books/fixture-book/second/index.html';
const detailPaths = [postPath, siblingPostPath, bookPath, firstPath, secondPath];

function markdown(data, body = '') {
  return `---\n${Object.entries(data)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n${body}\n`;
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `output must not contain symlinks: ${path}`);
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), `${path}/`)));
    else result.push(path);
  }
  return result.sort();
}

async function snapshot(directory) {
  const result = new Map();
  for (const path of await files(directory)) {
    let bytes = await readFile(join(directory, path));
    // Sitemap emission order can differ when routes are cached. Preserve every
    // entry (including duplicates), its contents, and the enclosing XML.
    if (/^sitemap-\d+\.xml$/.test(path) || path === '_internal/content-catalog.xml') {
      const xml = load(bytes.toString(), { xml: true });
      const entries = xml('urlset > url').toArray();
      entries.sort((a, b) => xml.xml(a).localeCompare(xml.xml(b)));
      xml('urlset > url').remove();
      xml('urlset').append(entries);
      bytes = Buffer.from(xml.xml());
    }
    result.set(path, createHash('sha256').update(bytes).digest('hex'));
  }
  return result;
}

function sameOutput(actual, expected, label) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label}: output paths`);
  for (const [path, hash] of expected) {
    assert.equal(actual.get(path), hash, `${label}: output bytes for ${path}`);
  }
}

function routeStatus(log, path, expected) {
  const line = log.split('\n').find((line) => line.includes(`/${path} `));
  assert.ok(line, `missing route log for ${path}:\n${log}`);
  const status = /\((cached|restored)\)/.exec(line)?.[1] ?? 'rendered';
  // The CLI normally empties dist, so reuse is logged as "restored".
  if (expected === 'cached')
    assert.ok(status === 'cached' || status === 'restored', `${path}: ${line}`);
  else assert.equal(status, expected, `${path}: ${line}`);
}

test(
  'incremental builds of real templates preserve freshness, route cleanup, and privacy',
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'turblog-incremental-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    };
    await cp(join(repoRoot, 'src'), join(root, 'src'), {
      recursive: true,
      filter: (path) => path !== join(repoRoot, 'src/content'),
    });
    for (const path of [
      'astro.config.mjs',
      'tsconfig.json',
      'package.json',
      'pnpm-lock.yaml',
      'scripts/build-content-catalog.mjs',
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(join(repoRoot, path), join(root, path));
    }
    await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    // Never use the default node_modules/.astro through the shared dependency link.
    await output(
      'fixture.config.mjs',
      `import config from './astro.config.mjs';
export default {
  ...config,
  cacheDir: './.fixture-cache/',
  vite: { ...config.vite, cacheDir: './.fixture-vite/' },
};
`,
    );

    const alpha = {
      title: 'Alpha public sentinel',
      slug: 'alpha',
      summary: 'Alpha summary sentinel',
      publishedAt: '2026-01-03',
      tags: ['fixture', 'alpha-only'],
      private: false,
    };
    const beta = {
      title: 'Beta control sentinel',
      slug: 'beta',
      summary: 'Beta summary sentinel',
      publishedAt: '2026-01-02',
      tags: ['fixture'],
    };
    const book = {
      slug: 'fixture-book',
      title: 'Fixture book sentinel',
      author: 'Fixture author',
      category: 'works',
      groupSlug: 'fixture-group',
      groupTitle: 'Fixture group',
      groupOrder: 1,
      seriesOrder: 1,
      summary: 'Fixture book summary',
      sourceUrl: 'https://example.test/source/',
      sourceName: 'Fixture source',
      rightsNotice: 'Synthetic test content',
      chapterCount: 2,
      private: false,
    };
    const first = {
      bookSlug: book.slug,
      chapterNumber: 1,
      slug: 'first',
      title: 'First chapter sentinel',
      sourcePath: 'https://example.test/source/1/',
    };
    const second = {
      bookSlug: book.slug,
      chapterNumber: 2,
      slug: 'second',
      title: 'Second chapter sentinel',
      sourcePath: 'https://example.test/source/2/',
    };
    const alphaSource = 'src/content/posts/alpha.md';
    const betaSource = 'src/content/posts/beta.md';
    const bookSource = 'src/content/books/fixture-book/book.md';
    const firstSource = 'src/content/books/fixture-book/chapters/first.md';
    const secondSource = 'src/content/books/fixture-book/chapters/second.md';
    let alphaBody =
      'Alpha body before.\n\n![Fixture private image](../../assets/incremental-private.png)';
    let firstBody = 'First body before.';
    await output(alphaSource, markdown(alpha, alphaBody));
    await output(betaSource, markdown(beta, 'Unchanged beta body.'));
    await output(
      'src/content/posts/deleted.md',
      markdown(
        { ...beta, slug: 'deleted', publishedAt: '2026-01-01', title: 'Deleted post sentinel' },
        'Deleted body.',
      ),
    );
    await output(bookSource, markdown(book));
    await output(firstSource, markdown(first, firstBody));
    await output(secondSource, markdown(second, 'Unchanged second body.'));
    const image = await sharp({
      create: { width: 24, height: 16, channels: 3, background: '#b52a39' },
    })
      .png()
      .toBuffer();
    await output('src/assets/incremental-private.png', image);
    await output('public/images/incremental-private.png', image);

    const dist = join(root, 'dist');
    const text = (path) => readFile(join(dist, path), 'utf8');
    const absent = (path) => assert.rejects(readFile(join(dist, path)), { code: 'ENOENT' }, path);
    const build = async (label, force = false) => {
      const start = performance.now();
      let result;
      try {
        result = await exec(
          process.execPath,
          [
            join(repoRoot, 'node_modules/astro/bin/astro.mjs'),
            'build',
            '--config',
            'fixture.config.mjs',
            ...(force ? ['--force'] : []),
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ASTRO_TELEMETRY_DISABLED: '1',
              PUBLIC_SITE_URL: 'https://example.test',
              PUBLIC_API_BASE_PATH: '/api/v1',
              NO_COLOR: '1',
              FORCE_COLOR: '0',
              TZ: 'UTC',
              TURBLOG_CATALOG_CACHE: force ? '0' : '1',
            },
            timeout: 45_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } catch (error) {
        assert.fail(
          `${label}: Astro CLI failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`,
        );
      }
      t.diagnostic(`${label}: ${Math.round(performance.now() - start)}ms`);
      return `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    };
    const compareFullBuild = async (label) => {
      const incremental = await snapshot(dist);
      for (const path of ['dist', '.fixture-cache', '.fixture-vite', '.astro']) {
        await rm(join(root, path), { recursive: true, force: true });
      }
      const log = await build(`${label} clean --force reference`, true);
      assert.doesNotMatch(log, /\((cached|restored)\)/, 'reference must render every route');
      sameOutput(incremental, await snapshot(dist), label);
    };

    await build('initial build');
    const initial = await snapshot(dist);
    await t.test('no-op reuses detail routes and produces identical output', async () => {
      const log = await build('no-op');
      assert.match(log, /reference cache: parsed=0 reused=[1-9]\d* pages=/);
      assert.ok(
        (await readFile(join(root, '.fixture-cache/content-catalog-references.json'))).length,
      );
      for (const path of detailPaths) routeStatus(log, path, 'cached');
      sameOutput(await snapshot(dist), initial, 'no-op');
      for (const path of [
        'index.html',
        'archive/index.html',
        'tags/fixture/index.html',
        'rss.xml',
        'sitemap-0.xml',
      ]) {
        assert.match(await text(path), /\/posts\/alpha\//, `public post starts in ${path}`);
      }
      assert.match(await text('books/index.html'), /\/books\/fixture-book\//);
      assert.deepEqual(JSON.parse(await text('book-access-manifest.json')), {
        version: 1,
        privateBooks: [],
      });
      assert.deepEqual(JSON.parse(await text('post-access-manifest.json')), {
        version: 1,
        privatePosts: [],
        privateAssets: {},
      });
      assert.deepEqual(await readFile(join(dist, 'images/incremental-private.png')), image);
    });

    await t.test('forced builds bypass a warm reference cache without rewriting it', async () => {
      const cachePath = join(root, '.fixture-cache/content-catalog-references.json');
      const before = await readFile(cachePath);
      const log = await build('force with warm reference cache', true);
      const match = /reference cache: parsed=(\d+) reused=(\d+) pages=(\d+)/.exec(log);
      assert.ok(match, 'privacy hook must report cache usage');
      assert.ok(Number(match[1]) > 0);
      assert.equal(match[1], match[3]);
      assert.equal(match[2], '0');
      assert.deepEqual(await readFile(cachePath), before);
      sameOutput(await snapshot(dist), initial, 'forced warm reference cache');
    });

    await t.test('body edits refresh only the affected post and chapter', async () => {
      alphaBody = alphaBody.replace('Alpha body before.', 'Alpha body after sentinel.');
      firstBody = 'First body after sentinel.';
      await output(alphaSource, markdown(alpha, alphaBody));
      await output(firstSource, markdown(first, firstBody));
      const log = await build('body edits');
      for (const path of [postPath, firstPath]) routeStatus(log, path, 'rendered');
      for (const path of [siblingPostPath, bookPath, secondPath]) routeStatus(log, path, 'cached');
      assert.match(await text(postPath), /Alpha body after sentinel/);
      assert.match(await text(firstPath), /First body after sentinel/);
      const current = await snapshot(dist);
      for (const path of [siblingPostPath, bookPath, secondPath])
        assert.equal(current.get(path), initial.get(path), `unchanged bytes: ${path}`);
      await compareFullBuild('body edits');
    });

    await t.test('title edits refresh the post, book TOC, and sibling navigation', async () => {
      alpha.title = 'Alpha revised title sentinel';
      first.title = 'Renamed first chapter sentinel';
      await output(alphaSource, markdown(alpha, alphaBody));
      await output(firstSource, markdown(first, firstBody));
      const log = await build('post and chapter titles');
      for (const path of [postPath, bookPath, firstPath, secondPath])
        routeStatus(log, path, 'rendered');
      assert.equal(
        load(await text(postPath))('h1')
          .text()
          .trim(),
        alpha.title,
      );
      routeStatus(log, siblingPostPath, 'cached');
      for (const path of [bookPath, firstPath, secondPath])
        assert.match(await text(path), /Renamed first chapter sentinel/);
      const sibling = load(await text(secondPath));
      assert.match(sibling('.book-reader-nav a').text(), /Renamed first chapter sentinel/);
    });

    await t.test('chapter ordering refreshes TOCs and previous/next links', async () => {
      first.chapterNumber = 2;
      second.chapterNumber = 1;
      await output(firstSource, markdown(first, firstBody));
      await output(secondSource, markdown(second, 'Unchanged second body.'));
      const log = await build('chapter ordering');
      for (const path of [bookPath, firstPath, secondPath]) {
        routeStatus(log, path, 'rendered');
        const page = load(await text(path));
        assert.deepEqual(
          page('.book-toc')
            .first()
            .find('li a')
            .toArray()
            .map((node) => page(node).attr('href')),
          ['/books/fixture-book/second/', '/books/fixture-book/first/'],
        );
      }
      const firstPage = load(await text(firstPath));
      assert.equal(
        firstPage('.book-reader-nav a:not(.reader-nav-next)').attr('href'),
        '/books/fixture-book/second/',
      );
      assert.equal(firstPage('.reader-nav-next').length, 0);
      const secondPage = load(await text(secondPath));
      assert.equal(secondPage('.reader-nav-next').attr('href'), '/books/fixture-book/first/');
      assert.equal(secondPage('.book-reader-nav a:not(.reader-nav-next)').length, 0);
    });

    await t.test('book metadata refreshes details and both chapter layouts', async () => {
      book.title = 'Updated book metadata sentinel';
      book.summary = 'Updated book summary sentinel';
      await output(bookSource, markdown(book));
      const log = await build('book metadata');
      for (const path of [bookPath, firstPath, secondPath]) {
        routeStatus(log, path, 'rendered');
        assert.match(await text(path), /Updated book metadata sentinel/);
        assert.match(await text(path), /Updated book summary sentinel/);
      }
      routeStatus(log, siblingPostPath, 'cached');
    });

    await t.test('deletion and slug rename remove obsolete routes and links', async () => {
      await rm(join(root, 'src/content/posts/deleted.md'));
      beta.slug = 'beta-renamed';
      await output(betaSource, markdown(beta, 'Unchanged beta body.'));
      await rename(join(root, betaSource), join(root, 'src/content/posts/beta-renamed.md'));
      second.slug = 'second-renamed';
      await output(secondSource, markdown(second, 'Unchanged second body.'));
      await build('delete and rename');
      for (const path of ['posts/deleted/index.html', siblingPostPath, secondPath])
        await absent(path);
      assert.match(await text('posts/beta-renamed/index.html'), /Beta control sentinel/);
      assert.match(
        await text('books/fixture-book/second-renamed/index.html'),
        /Second chapter sentinel/,
      );
      for (const path of await files(dist)) {
        if (!/\.(html|xml|json)$/.test(path)) continue;
        assert.doesNotMatch(
          await text(path),
          /\/posts\/(?:deleted|beta)\/|\/books\/fixture-book\/second\//,
          `obsolete link in ${path}`,
        );
      }
    });

    const assertPrivacy = async () => {
      await absent(postPath);
      assert.match(await text('_internal/posts/alpha/index.html'), /Alpha body after sentinel/);
      for (const path of [
        'index.html',
        'archive/index.html',
        'tags/index.html',
        'tags/fixture/index.html',
        'books/index.html',
        'rss.xml',
        ...(await files(dist)).filter((path) => /^sitemap.*\.xml$/.test(path)),
      ]) {
        const source = await text(path);
        assert.ok(!source.includes(alpha.title), `private title leaked in ${path}`);
        assert.doesNotMatch(
          source,
          /Alpha summary sentinel|\/posts\/alpha\/|alpha-only|\/books\/fixture-book\//,
          `private entry leaked in ${path}`,
        );
      }
      await absent('tags/alpha-only/index.html');
      assert.ok((await text('_owner/index.html')).includes(alpha.title));
      assert.match(await text('books/_owner/index.html'), /Updated book metadata sentinel/);
      assert.match(await text('_internal/content-catalog.xml'), /\/posts\/alpha\//);
      assert.deepEqual(JSON.parse(await text('book-access-manifest.json')), {
        version: 1,
        privateBooks: ['fixture-book'],
      });
      const manifest = JSON.parse(await text('post-access-manifest.json'));
      assert.equal(manifest.version, 1);
      assert.deepEqual(manifest.privatePosts, ['alpha']);
      const assets = Object.keys(manifest.privateAssets);
      assert.ok(
        assets.includes('/images/incremental-private.png'),
        'protect the duplicate public source image',
      );
      assert.ok(
        assets.some((path) => path.startsWith('/_astro/')),
        'protect generated source-image assets',
      );
      assert.deepEqual(
        (await files(dist)).filter(
          (path) => !path.startsWith('_internal/') && path.includes('incremental-private'),
        ),
        [],
        'no unprotected source copies or image renditions',
      );
      for (const path of assets) {
        assert.deepEqual(manifest.privateAssets[path], ['alpha']);
        await absent(path.slice(1));
        assert.ok((await readFile(join(dist, '_internal/assets', path))).length);
      }
      const privatePage = load(await text('_internal/posts/alpha/index.html'));
      assert.equal(privatePage('meta[name="robots"]').attr('content'), 'noindex, noarchive');
      const imagePath = privatePage('.prose img').attr('src');
      assert.ok(imagePath?.startsWith('/_astro/'));
      assert.ok(assets.includes(imagePath), 'rendered image is protected');
    };

    await t.test(
      'public-to-private regenerates lists, feeds, manifests, and image protection',
      async () => {
        alpha.private = true;
        book.private = true;
        await output(alphaSource, markdown(alpha, alphaBody));
        await output(bookSource, markdown(book));
        await build('public to private');
        await assertPrivacy();
      },
    );

    await t.test(
      'cached private output is restored and protected again, matching a clean build',
      async () => {
        const before = await snapshot(dist);
        const log = await build('private no-op');
        routeStatus(log, postPath, 'restored');
        routeStatus(log, firstPath, 'cached');
        await assertPrivacy();
        sameOutput(await snapshot(dist), before, 'private no-op');
        await compareFullBuild('private incremental output');
        await assertPrivacy();
      },
    );

    await t.test(
      'a shared template edit refreshes cached pages and matches a clean build',
      async () => {
        const path = 'src/layouts/SiteLayout.astro';
        const source = await readFile(join(root, path), 'utf8');
        assert.ok(source.includes('<body data-api-base-path={apiBasePath}>'));
        await output(
          path,
          source.replace(
            '<body data-api-base-path={apiBasePath}>',
            '<body data-api-base-path={apiBasePath} data-incremental-template="updated">',
          ),
        );
        const log = await build('shared template edit');
        for (const path of [
          postPath,
          'posts/beta-renamed/index.html',
          bookPath,
          firstPath,
          'books/fixture-book/second-renamed/index.html',
        ])
          routeStatus(log, path, 'rendered');
        for (const path of (await files(dist)).filter((path) => path.endsWith('.html')))
          assert.match(await text(path), /data-incremental-template="updated"/, path);
        await assertPrivacy();
        await compareFullBuild('template incremental output');
      },
    );
  },
);

// @ts-nocheck
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'astro';
import { load } from 'cheerio';
import repoConfig from '../astro.config.mjs';
import { importTranslatedBook } from './import-translated-book.mjs';

test('an imported translation is private across the real Astro collections, shelves, and sitemap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'turblog-translated-book-astro-'));
  const previousDirectory = process.cwd();
  const previousTelemetry = process.env.ASTRO_TELEMETRY_DISABLED;
  process.env.ASTRO_TELEMETRY_DISABLED = '1';
  t.after(async () => {
    if (previousTelemetry === undefined) delete process.env.ASTRO_TELEMETRY_DISABLED;
    else process.env.ASTRO_TELEMETRY_DISABLED = previousTelemetry;
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Real network access is forbidden in this integration test.');
  });
  // Astro's collection glob bases must resolve inside the fixture, not the checkout.
  process.chdir(root);
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  const output = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await output('package.json', '{"type":"module"}');
  for (const path of [
    'src/content.config.ts',
    'src/lib/books.ts',
    'src/pages/book-access-manifest.json.ts',
    'src/pages/post-access-manifest.json.ts',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repoRoot, path), join(root, path));
  }

  const title = 'Synthetic private translated book';
  const body =
    'Synthetic private chapter body sentinel\n\n# literal heading\n\n- literal list\n\n1. literal ordered list\n\n---\n\n<script>alert(1)</script>\n\n    indented text';
  const slug = 'syosetu-n1234ab-zh-hans';
  const sourceUrl = 'https://novel18.syosetu.com/n1234ab/';
  const chapter = {
    file: 'chapters/1.json',
    sourceUrl: `${sourceUrl}1/`,
    title: 'Synthetic translated chapter',
    group: 'Synthetic volume',
  };
  await output(
    'translation/manifest.json',
    JSON.stringify({
      version: 1,
      complete: true,
      machineTranslated: true,
      sourceUrl,
      language: 'zh-Hans',
      title,
      summary: 'Synthetic private summary',
      author: 'Synthetic author',
      chapters: [chapter],
    }),
  );
  await output(
    'translation/chapters/1.json',
    JSON.stringify({
      version: 1,
      machineTranslated: true,
      sourceUrl: chapter.sourceUrl,
      title: chapter.title,
      group: chapter.group,
      body: { text: body, markdown: body },
      preface: { text: '', markdown: '' },
      afterword: { text: '', markdown: '' },
    }),
  );
  const booksRoot = join(root, 'src/content/books');
  const imported = await importTranslatedBook(join(root, 'translation'), {
    booksRoot,
    log: () => {},
  });
  assert.equal(imported.slug, slug);
  assert.equal(imported.directory, join(booksRoot, slug));
  assert.equal(imported.chapterCount, 1);
  await output(
    'src/content/books/public-control/book.md',
    `---
slug: public-control
title: Synthetic public control
author: Synthetic author
category: works
groupSlug: public-control
groupTitle: Synthetic public group
groupOrder: 1
seriesOrder: 1
summary: Synthetic public summary
sourceUrl: https://example.test/public/
sourceName: Synthetic source
rightsNotice: Synthetic test fixture
chapterCount: 1
---
`,
  );
  await output(
    'src/content/books/public-control/chapters/chapter-01.md',
    `---
bookSlug: public-control
chapterNumber: 1
slug: chapter-01
title: Synthetic public chapter
sourcePath: https://example.test/public/1/
---
Synthetic public body
`,
  );
  await output(
    'src/content/posts/public-control.md',
    `---
title: Synthetic public post
slug: public-control
summary: Synthetic public post summary
publishedAt: 2026-01-01
tags: [fixture]
---
Synthetic public post body
`,
  );
  for (const [path, includePrivate, library] of [
    ['src/pages/books/index.astro', false, '../../lib/books'],
    ['src/pages/books/_owner/index.astro', true, '../../../lib/books'],
  ]) {
    await output(
      path,
      `---
import { getBookGroups, bookPath } from '${library}';
const groups = await getBookGroups(${includePrivate ? 'true' : ''});
---
<html><body>{groups.map(group => <section><h1>{group.title}</h1>{group.books.map(book => <a href={bookPath(book)}>{book.data.title}</a>)}</section>)}</body></html>`,
    );
  }
  await output(
    'src/pages/books/[bookSlug]/index.astro',
    `---
import { getBooks, getBookChapters, chapterPath } from '../../../lib/books';
export async function getStaticPaths() {
  return (await getBooks()).map(book => ({ params: { bookSlug: book.data.slug }, props: { book } }));
}
const { book } = Astro.props;
const chapters = await getBookChapters(book.data.slug);
---
<html><body><h1>{book.data.title}</h1>{chapters.map(chapter => <a href={chapterPath(book, chapter)}>{chapter.data.title}</a>)}</body></html>`,
  );
  await output(
    'src/pages/books/[bookSlug]/[chapterSlug].astro',
    `---
import { render } from 'astro:content';
import { getBooks, getBookChapters } from '../../../lib/books';
export async function getStaticPaths() {
  return (await Promise.all((await getBooks()).map(async book =>
    (await getBookChapters(book.data.slug)).map(chapter => ({
      params: { bookSlug: book.data.slug, chapterSlug: chapter.data.slug }, props: { chapter }
    }))
  ))).flat();
}
const { Content } = await render(Astro.props.chapter);
---
<html><body><Content /></body></html>`,
  );

  const integrations = ['@astrojs/sitemap', 'content-catalog-privacy'].map((name) => {
    const integration = repoConfig.integrations.find((integration) => integration.name === name);
    assert.ok(integration, `production integration exists: ${name}`);
    return integration;
  });
  await build({
    root,
    configFile: false,
    site: 'https://example.test',
    logLevel: 'silent',
    integrations: [
      {
        name: 'fixture-owner-shelf',
        hooks: {
          'astro:config:setup': ({ injectRoute }) => {
            injectRoute({
              pattern: '/books/_owner/',
              entrypoint: './src/pages/books/_owner/index.astro',
              prerender: true,
            });
          },
        },
      },
      ...integrations,
    ],
  });

  const dist = join(root, 'dist');
  const text = (path) => readFile(join(dist, path), 'utf8');
  const publicShelf = await text('books/index.html');
  assert.ok(publicShelf.includes('Synthetic public control'));
  assert.ok(!publicShelf.includes(title), 'private title must not appear on the public shelf');
  assert.ok(!publicShelf.includes(slug), 'private book link must not appear on the public shelf');
  const ownerShelf = await text('books/_owner/index.html');
  assert.ok(ownerShelf.includes(title));
  assert.ok(ownerShelf.includes(`/books/${slug}/`));
  assert.ok(ownerShelf.includes('Synthetic public control'));
  assert.deepEqual(JSON.parse(await text('book-access-manifest.json')), {
    version: 1,
    privateBooks: [slug],
  });
  const bookPage = load(await text(`books/${slug}/index.html`));
  assert.ok(bookPage('h1').text().includes(title));
  const chapterLinks = bookPage('a[href]')
    .toArray()
    .map((node) => bookPage(node).attr('href'));
  assert.equal(chapterLinks.length, 1);
  const chapterPath = chapterLinks[0];
  assert.ok(chapterPath.startsWith(`/books/${slug}/`));
  // Books remain static output; production Go guards these paths and the owner shelf.
  const chapterPage = load(await text(`${chapterPath.slice(1)}index.html`));
  assert.equal(
    chapterPage('h1, h2, script, img, hr, ul, ol, pre').length,
    0,
    'source plaintext must not create Markdown blocks or HTML elements',
  );
  assert.equal(
    chapterPage('body').text().replace(/\s+/g, ' ').trim(),
    body.replace(/\s+/g, ' ').trim(),
  );

  const sitemapFiles = (await readdir(dist)).filter((path) => /^sitemap-\d+\.xml$/.test(path));
  assert.ok(sitemapFiles.length > 0, 'a real sitemap must be generated');
  const publicPaths = new Set();
  for (const path of sitemapFiles) {
    const source = await text(path);
    assert.ok(!source.includes(title));
    assert.ok(!source.includes(slug), 'private book and chapter URLs must be removed');
    assert.ok(!source.includes('_owner'), 'owner shelf must be removed');
    assert.ok(
      !source.includes('access-manifest.json'),
      'production sitemap filter excludes manifests',
    );
    const xml = load(source, { xml: true });
    for (const node of xml('url > loc').toArray()) {
      publicPaths.add(new URL(xml(node).text()).pathname);
    }
  }
  for (const path of ['/books/', '/books/public-control/', '/books/public-control/chapter-01/']) {
    assert.ok(publicPaths.has(path), `public control remains in sitemap: ${path}`);
  }
  const catalog = load(await text('_internal/content-catalog.xml'), { xml: true });
  const internalPaths = new Set(
    catalog('url > loc')
      .toArray()
      .map((node) => new URL(catalog(node).text()).pathname),
  );
  for (const path of [`/books/${slug}/`, chapterPath, '/books/_owner/']) {
    assert.ok(internalPaths.has(path), `internal catalog retains guarded route: ${path}`);
  }
});

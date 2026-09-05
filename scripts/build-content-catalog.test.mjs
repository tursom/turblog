import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'cheerio';
import { buildContentCatalog } from './build-content-catalog.mjs';

/** @param {string[]} paths */
const sitemap = (paths) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>https://example.test${path}</loc><lastmod>2026-01-01</lastmod></url>`).join('')}</urlset>`;
/** @param {string} source */
const locations = (source) => {
  const xml = load(source, { xml: true });
  return xml('url > loc')
    .map((_, node) => xml(node).text())
    .get();
};

/**
 * @param {import('node:test').TestContext} t
 * @param {unknown} manifest
 */
async function fixture(t, manifest = { version: 1, privateBooks: ['private-book'] }) {
  const directory = await mkdtemp(join(tmpdir(), 'turblog-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'book-access-manifest.json'), JSON.stringify(manifest));
  await writeFile(
    join(directory, 'post-access-manifest.json'),
    JSON.stringify({ version: 1, privatePosts: [], privateAssets: {} }),
  );
  return directory;
}

test('keeps the complete chunked catalog internally and publishes only public routes', async (t) => {
  const directory = await fixture(t);
  const publicPaths = [
    '/books/',
    '/books/public-book/',
    '/books/private-book-extra/chapter/',
    '/posts/article/',
  ];
  const privatePaths = [
    '/books/private-book/',
    '/books/private-book/chapter/',
    '/books/_owner/',
    '/books/_owner/index.html',
  ];
  await writeFile(join(directory, 'sitemap-0.xml'), sitemap([...publicPaths, privatePaths[0]]));
  await writeFile(join(directory, 'sitemap-1.xml'), sitemap(privatePaths.slice(1)));
  const index =
    '<sitemapindex><sitemap><loc>https://example.test/sitemap-0.xml</loc></sitemap><sitemap><loc>https://example.test/sitemap-1.xml</loc></sitemap></sitemapindex>';
  await writeFile(join(directory, 'sitemap-index.xml'), index);
  await mkdir(join(directory, 'books/private-book'), { recursive: true });
  await writeFile(join(directory, 'books/private-book/index.html'), 'private content');

  await buildContentCatalog(directory);

  const internal = await readFile(join(directory, '_internal/content-catalog.xml'), 'utf8');
  assert.deepEqual(
    locations(internal),
    [...publicPaths, ...privatePaths].map((path) => `https://example.test${path}`),
  );
  const publicXML = await readFile(join(directory, 'sitemap-0.xml'), 'utf8');
  assert.deepEqual(
    locations(publicXML),
    publicPaths.map((path) => `https://example.test${path}`),
  );
  assert.match(publicXML, /<lastmod>2026-01-01<\/lastmod>/);
  assert.deepEqual(locations(await readFile(join(directory, 'sitemap-1.xml'), 'utf8')), []);
  assert.equal(await readFile(join(directory, 'sitemap-index.xml'), 'utf8'), index);
  assert.equal(
    await readFile(join(directory, 'books/private-book/index.html'), 'utf8'),
    'private content',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'book-access-manifest.json'), 'utf8')),
    { version: 1, privateBooks: ['private-book'] },
  );
});

test('removes owner routes even without private books and preserves XML escaping', async (t) => {
  const directory = await fixture(t, { version: 1, privateBooks: [] });
  await writeFile(
    join(directory, 'sitemap-0.xml'),
    sitemap(['/books/_owner/', '/books/public-book/?a=1&amp;b=2']),
  );
  await buildContentCatalog(directory);
  assert.deepEqual(locations(await readFile(join(directory, 'sitemap-0.xml'), 'utf8')), [
    'https://example.test/books/public-book/?a=1&b=2',
  ]);
});

test('fails closed on invalid or missing build inputs', async (t) => {
  for (const manifest of [
    null,
    { version: 2, privateBooks: [] },
    { version: 1 },
    { version: 1, privateBooks: ['bad/slug'] },
  ]) {
    const directory = await fixture(t, manifest);
    await assert.rejects(buildContentCatalog(directory), /Invalid v1 book access manifest/);
  }
  const directory = await fixture(t);
  await assert.rejects(buildContentCatalog(directory), /No generated sitemap chunks/);
  await writeFile(join(directory, 'sitemap-0.xml'), '<invalid/>');
  await assert.rejects(buildContentCatalog(directory), /Invalid sitemap chunk/);
  await rm(join(directory, 'book-access-manifest.json'));
  await assert.rejects(buildContentCatalog(directory), /ENOENT/);
});

/** @param {string} directory @param {string} path @param {string} contents */
async function output(directory, path, contents) {
  await mkdir(join(directory, path, '..'), { recursive: true });
  await writeFile(join(directory, path), contents);
}

/** @param {string} directory @param {string[]} slugs */
async function privatePosts(directory, slugs) {
  await output(
    directory,
    'post-access-manifest.json',
    JSON.stringify({ version: 1, privatePosts: slugs, privateAssets: {} }),
  );
}

test('relocates private details and media, keeps shared assets public, and retains canonical internal URLs', async (t) => {
  const directory = await fixture(t);
  await privatePosts(directory, ['secret', 'other-secret']);
  const publicPaths = ['/', '/archive/', '/tags/test/', '/posts/public/'];
  const hiddenPaths = [
    '/posts/secret/',
    '/posts/other-secret/',
    '/_owner/',
    '/_owner/archive/2/',
    '/_owner/tags/test/',
    '/books/_owner/',
  ];
  await output(directory, 'sitemap-0.xml', sitemap([...publicPaths, ...hiddenPaths]));
  const detail =
    '<img src="/images/private.png"><picture><source srcset="/_astro/imported.AbCd1234_small.webp 480w, /_astro/imported.AbCd1234_large.webp 800w"><img src="/_astro/imported.AbCd1234_large.webp"></picture><img src="/images/shared.webp"><a href="/downloads/private.pdf?download=1">attachment</a><script src="/_astro/common.js"></script><link rel="stylesheet" href="/_astro/common.css"><img src="/favicon.svg">';
  await output(directory, 'posts/secret/index.html', detail);
  await output(directory, 'posts/other-secret/index.html', '<img src="/images/private.png">');
  await output(
    directory,
    'posts/public/index.html',
    '<img src="/images/shared.webp"><img src="https://external.test/images/private.png">',
  );
  await output(
    directory,
    '_owner/index.html',
    '<article><a href="/posts/secret/"><img src="/images/private.png"></a></article><article><a href="/posts/other-secret/"><img src="/images/owner-cover.png"></a></article>',
  );
  const assets = {
    'images/private.png': 'private original',
    'images/private-480.webp': 'private resized',
    'images/copy.png': 'private original',
    '_astro/imported.AbCd1234_small.webp': 'small Astro rendition',
    '_astro/imported.AbCd1234_large.webp': 'large Astro rendition',
    '_astro/imported.AbCd1234.png': 'Astro original',
    'images/owner-cover.png': 'owner cover',
    'downloads/private.pdf': 'private attachment',
    'images/shared.webp': 'shared rendition',
    'images/shared.png': 'shared source',
    '_astro/common.js': 'common script',
    '_astro/common.css': 'common style',
    'favicon.svg': 'common icon',
  };
  for (const [path, contents] of Object.entries(assets)) await output(directory, path, contents);
  await buildContentCatalog(directory);
  assert.deepEqual(
    locations(await readFile(join(directory, 'sitemap-0.xml'), 'utf8')),
    publicPaths.map((path) => `https://example.test${path}`),
  );
  assert.deepEqual(
    locations(await readFile(join(directory, '_internal/content-catalog.xml'), 'utf8')),
    [...publicPaths, ...hiddenPaths].map((path) => `https://example.test${path}`),
  );
  assert.equal(
    await readFile(join(directory, '_internal/posts/secret/index.html'), 'utf8'),
    detail,
  );
  await assert.rejects(readFile(join(directory, 'posts/secret/index.html')), /ENOENT/);
  await assert.rejects(readFile(join(directory, 'posts/other-secret/index.html')), /ENOENT/);
  const manifest = JSON.parse(await readFile(join(directory, 'post-access-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.privatePosts, ['other-secret', 'secret']);
  assert.deepEqual(manifest.privateAssets, {
    '/images/private.png': ['other-secret', 'secret'],
    '/images/private-480.webp': ['other-secret', 'secret'],
    '/images/copy.png': ['other-secret', 'secret'],
    '/_astro/imported.AbCd1234_small.webp': ['secret'],
    '/_astro/imported.AbCd1234_large.webp': ['secret'],
    '/_astro/imported.AbCd1234.png': ['secret'],
    '/images/owner-cover.png': ['other-secret'],
    '/downloads/private.pdf': ['secret'],
  });
  for (const [path, contents] of Object.entries(assets)) {
    const privateAsset = manifest.privateAssets[`/${path}`];
    assert.equal(
      await readFile(join(directory, privateAsset ? '_internal/assets' : '', path), 'utf8'),
      contents,
    );
    if (privateAsset) await assert.rejects(readFile(join(directory, path)), /ENOENT/);
  }
});

test('rejects invalid post manifests, missing private output, missing media, and ambiguous owner assets', async (t) => {
  for (const manifest of [
    null,
    {},
    { version: 2, privatePosts: [], privateAssets: {} },
    { version: 1, privatePosts: [] },
    { version: 1, privatePosts: ['bad/slug'], privateAssets: {} },
    { version: 1, privatePosts: ['same', 'same'], privateAssets: {} },
    { version: 1, privatePosts: [], privateAssets: [] },
    { version: 1, privatePosts: [], privateAssets: { '/image.png': ['secret'] } },
    { version: 1, privatePosts: [], privateAssets: {}, extra: true },
  ]) {
    const directory = await fixture(t);
    await output(directory, 'post-access-manifest.json', JSON.stringify(manifest));
    await assert.rejects(buildContentCatalog(directory), /Invalid initial v1 post access manifest/);
  }
  const directory = await fixture(t);
  await privatePosts(directory, ['secret']);
  await output(directory, 'sitemap-0.xml', sitemap(['/posts/secret/']));
  await assert.rejects(buildContentCatalog(directory), /Missing canonical private post output/);
  await output(directory, 'posts/secret/index.html', '<img src="/images/missing.png">');
  await assert.rejects(buildContentCatalog(directory), /Missing private local asset/);
  await output(directory, 'posts/secret/index.html', '<img src="/images/extensionless">');
  await assert.rejects(buildContentCatalog(directory), /Unsupported private local media URL/);
  await output(directory, 'posts/secret/index.html', 'private detail');
  await output(directory, '_owner/index.html', '<img src="/images/unknown.png">');
  await output(directory, 'images/unknown.png', 'unknown cover owner');
  await assert.rejects(buildContentCatalog(directory), /Cannot determine private post owner/);
  await output(directory, '_owner/index.html', 'owner list');
  await output(directory, 'posts/secret/extra.html', 'unexpected duplicate output');
  await assert.rejects(buildContentCatalog(directory), /Unexpected public files/);
  assert.equal(
    await readFile(join(directory, 'posts/secret/index.html'), 'utf8'),
    'private detail',
  );
});

test('protects metadata-only covers and ignores malformed external links', async (t) => {
  const directory = await fixture(t);
  await privatePosts(directory, ['secret']);
  await output(directory, 'sitemap-0.xml', sitemap(['/posts/secret/', '/']));
  await output(
    directory,
    'posts/secret/index.html',
    '<meta property="og:image" content="/images/metadata-cover.jpg"><meta name="twitter:image" content="/images/metadata-cover.jpg"><p>Private article</p>',
  );
  await output(
    directory,
    'index.html',
    '<a href="http://www.ewen.cc%E3%80%80www.yiwen.com.cn%EF%BC%89">Legacy external link</a>',
  );
  await output(directory, 'images/metadata-cover.jpg', 'private metadata cover');
  await buildContentCatalog(directory);
  const manifest = JSON.parse(await readFile(join(directory, 'post-access-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.privateAssets, { '/images/metadata-cover.jpg': ['secret'] });
  await assert.rejects(readFile(join(directory, 'images/metadata-cover.jpg')), /ENOENT/);
  assert.equal(
    await readFile(join(directory, '_internal/assets/images/metadata-cover.jpg'), 'utf8'),
    'private metadata cover',
  );
});

test('a public rendition keeps its original and other copies public', async (t) => {
  const directory = await fixture(t);
  await privatePosts(directory, ['secret']);
  await output(directory, 'sitemap-0.xml', sitemap(['/posts/secret/', '/']));
  await output(directory, 'posts/secret/index.html', '<img src="/_astro/shared_hash.webp">');
  await output(directory, 'index.html', '<img src="/images/shared.png">');
  await output(directory, '_astro/shared_hash.webp', 'rendition');
  await output(directory, 'images/shared.png', 'source');
  await buildContentCatalog(directory);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'post-access-manifest.json'), 'utf8')).privateAssets,
    {},
  );
  assert.equal(await readFile(join(directory, '_astro/shared_hash.webp'), 'utf8'), 'rendition');
});

test('ambiguous source copies fail before any private HTML is moved', async (t) => {
  const directory = await fixture(t);
  await privatePosts(directory, ['secret']);
  await output(directory, 'sitemap-0.xml', sitemap(['/posts/secret/']));
  await output(directory, 'posts/secret/index.html', '<img src="/_astro/photo_hash.webp">');
  await output(directory, '_astro/photo_hash.webp', 'private rendition');
  await output(directory, 'images/first/photo.png', 'first original');
  await output(directory, 'images/second/photo.png', 'second original');
  await assert.rejects(buildContentCatalog(directory), /Ambiguous private image source copies/);
  assert.match(await readFile(join(directory, 'posts/secret/index.html'), 'utf8'), /private|photo/);
});

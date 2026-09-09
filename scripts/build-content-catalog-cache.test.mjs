import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContentCatalog } from './build-content-catalog.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turblog-catalog-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const cacheDir = join(root, 'cache');
  /** @param {string} path @param {string} contents */
  const output = async (path, contents) => {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), contents);
  };
  /** @param {string[]} slugs */
  const privacy = (slugs) =>
    output(
      'post-access-manifest.json',
      JSON.stringify({ version: 1, privatePosts: slugs, privateAssets: {} }),
    );
  await output('book-access-manifest.json', '{"version":1,"privateBooks":[]}');
  await privacy(['secret']);
  await output(
    'sitemap-0.xml',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/</loc></url><url><loc>https://example.test/posts/secret/</loc></url></urlset>',
  );
  await output(
    'posts/secret/index.html',
    '<img src="/images/secret.png"><img src="/images/shared.png">',
  );
  await output('index.html', '<img src="/images/shared.png">');
  await output('images/secret.png', 'secret bytes');
  await output('images/shared.png', 'shared bytes');
  let run = 0;
  const build = async (cached = true) => {
    const directory = join(root, `build-${run++}`);
    await cp(source, directory, { recursive: true });
    const metrics = await buildContentCatalog(directory, cached ? { cacheDir } : {});
    const manifest = JSON.parse(
      await readFile(join(directory, 'post-access-manifest.json'), 'utf8'),
    );
    return { directory, metrics, manifest };
  };
  const cacheFile = join(cacheDir, 'content-catalog-references.json');
  return { root, source, cacheDir, cacheFile, output, privacy, build };
}

/** @param {string} directory @returns {Promise<Record<string, string>>} */
async function snapshot(directory) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, bytes] of Object.entries(await snapshot(path)))
        result[`${entry.name}/${child}`] = bytes;
    } else result[entry.name] = (await readFile(path)).toString('base64');
  }
  return result;
}

test('warm reference caches avoid HTML parsing and match uncached output byte for byte', async (t) => {
  const f = await fixture(t);
  const cold = await f.build();
  assert.equal(cold.metrics.parsedPages, 2);
  assert.equal(cold.metrics.reusedPages, 0);
  const warm = await f.build();
  assert.equal(warm.metrics.parsedPages, 0);
  assert.equal(warm.metrics.reusedPages, 2);
  const fresh = await f.build(false);
  assert.deepEqual(await snapshot(warm.directory), await snapshot(fresh.directory));
  assert.deepEqual(await snapshot(cold.directory), await snapshot(fresh.directory));
  for (const duration of Object.values(warm.metrics.timings))
    assert.ok(Number.isFinite(duration) && duration >= 0);
  assert.ok(
    !Object.keys(await snapshot(warm.directory)).some((path) =>
      path.includes('content-catalog-references'),
    ),
  );
});

test('HTML edits and deleted public references refresh sharing and prune cached pages', async (t) => {
  const f = await fixture(t);
  await f.build();
  await f.output('index.html', '<p>No shared image now</p>');
  const edited = await f.build();
  assert.equal(edited.metrics.parsedPages, 1);
  assert.equal(edited.metrics.reusedPages, 1);
  assert.deepEqual(edited.manifest.privateAssets['/images/shared.png'], ['secret']);
  await rm(join(f.source, 'index.html'));
  const deleted = await f.build();
  assert.equal(deleted.metrics.reusedPages, 1);
  assert.deepEqual(deleted.manifest.privateAssets['/images/shared.png'], ['secret']);
  const cache = JSON.parse(await readFile(f.cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(cache.pages), ['posts/secret/index.html']);
  const fresh = await f.build(false);
  assert.deepEqual(await snapshot(deleted.directory), await snapshot(fresh.directory));
});

test('privacy changes and site origin changes invalidate cached interpretations', async (t) => {
  const f = await fixture(t);
  await f.build();
  await f.privacy([]);
  const publicBuild = await f.build();
  assert.equal(publicBuild.metrics.parsedPages, 1);
  assert.deepEqual(publicBuild.manifest.privateAssets, {});
  await f.privacy(['secret']);
  const privateBuild = await f.build();
  assert.equal(privateBuild.metrics.parsedPages, 1);
  assert.deepEqual(privateBuild.manifest.privateAssets['/images/secret.png'], ['secret']);
  await f.output('posts/secret/index.html', '<img src="https://example.test/images/secret.png">');
  await f.build();
  await f.output(
    'sitemap-0.xml',
    '<urlset><url><loc>https://other.test/</loc></url><url><loc>https://other.test/posts/secret/</loc></url></urlset>',
  );
  const movedSite = await f.build();
  assert.equal(movedSite.metrics.parsedPages, 2);
  assert.deepEqual(movedSite.manifest.privateAssets, {});
});

test('warm references still check missing assets and changed duplicate bytes', async (t) => {
  const f = await fixture(t);
  await f.output('images/copy.png', 'unrelated bytes');
  await f.build();
  await f.output('images/copy.png', 'secret bytes');
  const duplicate = await f.build();
  assert.equal(duplicate.metrics.parsedPages, 0);
  assert.deepEqual(duplicate.manifest.privateAssets['/images/copy.png'], ['secret']);
  await rm(join(f.source, 'images/secret.png'));
  await assert.rejects(f.build(), /Missing private local asset/);
});

test('warm HTML references recompute sharing when public duplicate bytes change', async (t) => {
  const f = await fixture(t);
  await f.output('posts/secret/index.html', '<img src="/images/secret.png">');
  await f.output('images/shared.png', 'secret bytes');
  const cold = await f.build();
  assert.deepEqual(cold.manifest.privateAssets, {});
  await f.output('images/shared.png', 'changed public bytes');
  const warm = await f.build();
  assert.equal(warm.metrics.parsedPages, 0);
  assert.deepEqual(warm.manifest.privateAssets, { '/images/secret.png': ['secret'] });
  assert.equal(
    await readFile(join(warm.directory, 'images/shared.png'), 'utf8'),
    'changed public bytes',
  );
  const fresh = await f.build(false);
  assert.deepEqual(await snapshot(warm.directory), await snapshot(fresh.directory));
});

test('warm references reject new ambiguous source copies before moving private HTML', async (t) => {
  const f = await fixture(t);
  await f.output('posts/secret/index.html', '<img src="/_astro/photo_hash.webp">');
  await f.output('_astro/photo_hash.webp', 'private rendition');
  await f.output('images/first/photo.png', 'first original');
  await f.build();
  await f.output('images/second/photo.png', 'second original');
  const directory = join(f.root, 'ambiguous');
  await cp(f.source, directory, { recursive: true });
  await assert.rejects(
    buildContentCatalog(directory, { cacheDir: f.cacheDir }),
    /Ambiguous private image source copies/,
  );
  assert.match(await readFile(join(directory, 'posts/secret/index.html'), 'utf8'), /photo_hash/);
});

test('cache paths cannot alias the output through symlinks or linked ancestors', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'output-alias');
  await symlink(f.source, alias, 'dir');
  for (const cacheDir of [alias, join(alias, 'new-cache')]) {
    await assert.rejects(buildContentCatalog(f.source, { cacheDir }), /outside/);
  }
  await assert.rejects(
    buildContentCatalog(alias, { cacheDir: join(f.source, 'new-cache') }),
    /outside/,
  );
  assert.ok(
    !Object.keys(await snapshot(f.source)).some((path) =>
      path.includes('content-catalog-references'),
    ),
  );
});

test('owner page interpretations track private slugs and retain fail-closed checks', async (t) => {
  const f = await fixture(t);
  await f.output(
    '_owner/index.html',
    '<article><a href="/posts/secret/">Secret</a><img src="/images/owner.png"></article>',
  );
  await f.output('images/owner.png', 'owner cover bytes');
  await f.build();
  const warm = await f.build();
  assert.equal(warm.metrics.parsedPages, 0);
  assert.deepEqual(warm.manifest.privateAssets['/images/owner.png'], ['secret']);
  await f.privacy([]);
  await assert.rejects(f.build(), /Cannot determine private post owner/);
  await f.output('_owner/index.html', '<img src="/images/extensionless">');
  await assert.rejects(f.build(), /Unsupported private local media URL/);
});

test('corrupt, obsolete and missing cache records fall back to parsing', async (t) => {
  const f = await fixture(t);
  await f.build();
  const valid = await readFile(f.cacheFile, 'utf8');
  const invalidRecords = [
    '{broken',
    'null',
    JSON.stringify({ version: 'old', pages: {} }),
    JSON.stringify({ ...JSON.parse(valid), pages: [] }),
    JSON.stringify({ ...JSON.parse(valid), pages: { 'index.html': null } }),
  ];
  for (const cache of invalidRecords) {
    await writeFile(f.cacheFile, cache);
    const result = await f.build();
    assert.equal(result.metrics.parsedPages, 2);
    assert.deepEqual(result.manifest.privateAssets['/images/secret.png'], ['secret']);
  }
  const corrupted = JSON.parse(valid);
  corrupted.pages['posts/secret/index.html'].references = [];
  await writeFile(f.cacheFile, JSON.stringify(corrupted));
  const result = await f.build();
  assert.equal(result.metrics.parsedPages, 1);
  assert.deepEqual(result.manifest.privateAssets['/images/secret.png'], ['secret']);
});

test('unavailable cache is optional, but a cache inside dist is rejected', async (t) => {
  const f = await fixture(t);
  await writeFile(f.cacheDir, 'not a directory');
  const result = await f.build();
  assert.equal(result.metrics.parsedPages, 2);
  assert.ok(result.metrics.cacheWarnings.length > 0);
  assert.deepEqual(result.manifest.privateAssets['/images/secret.png'], ['secret']);
  await assert.rejects(
    buildContentCatalog(f.source, { cacheDir: join(f.source, 'cache') }),
    /outside/,
  );
});

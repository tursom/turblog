import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'astro';
import sitemap from '@astrojs/sitemap';
import sharp from 'sharp';
import { buildContentCatalog } from './build-content-catalog.mjs';

test('an isolated Astro build protects generated private images and source copies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'turblog-private-astro-'));
  const previousDirectory = process.cwd();
  t.after(async () => {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  });
  process.chdir(root);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    'dir',
  );
  /** @param {string} path @param {string | Buffer} content */
  const output = async (path, content) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await output('package.json', '{"type":"module"}');
  await output('public/book-access-manifest.json', '{"version":1,"privateBooks":[]}');
  await output(
    'public/post-access-manifest.json',
    '{"version":1,"privatePosts":["secret"],"privateAssets":{}}',
  );
  const privateImage = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#b52a39' },
  })
    .png()
    .toBuffer();
  const sharedImage = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#38a478' },
  })
    .png()
    .toBuffer();
  await output('src/assets/private.png', privateImage);
  await output('public/images/private.png', privateImage);
  await output('public/images/shared.png', sharedImage);
  await output(
    'src/pages/posts/secret.astro',
    `---
import { Image } from 'astro:assets';
import secret from '../../assets/private.png';
---
<html><body><Image src={secret} alt="private image" widths={[60, 120]} sizes="120px" /><img src="/images/shared.png" alt="shared image" /></body></html>`,
  );
  await output(
    'src/pages/index.astro',
    '<html><body><img src="/images/shared.png" alt="shared image" /></body></html>',
  );
  await build({
    root,
    configFile: false,
    site: 'https://example.test',
    logLevel: 'silent',
    integrations: [
      sitemap(),
      {
        name: 'test-content-privacy',
        hooks: { 'astro:build:done': async ({ dir }) => buildContentCatalog(fileURLToPath(dir)) },
      },
    ],
  });
  const dist = join(root, 'dist');
  const manifest = JSON.parse(await readFile(join(dist, 'post-access-manifest.json'), 'utf8'));
  const paths = Object.keys(manifest.privateAssets);
  assert.ok(paths.includes('/images/private.png'), 'protect the public-dir original copy');
  assert.ok(
    paths.filter((path) => path.startsWith('/_astro/')).length >= 2,
    'protect Astro src/srcset renditions',
  );
  for (const path of paths) {
    assert.deepEqual(manifest.privateAssets[path], ['secret']);
    await assert.rejects(readFile(join(dist, path)), /ENOENT/);
    assert.ok((await readFile(join(dist, '_internal/assets', path))).length);
  }
  assert.deepEqual(await readFile(join(dist, 'images/shared.png')), sharedImage);
  await assert.rejects(readFile(join(dist, 'posts/secret/index.html')), /ENOENT/);
  assert.match(await readFile(join(dist, '_internal/posts/secret/index.html'), 'utf8'), /srcset=/);
  const remaining = await readdir(join(dist, '_astro'));
  assert.ok(
    !remaining.some((path) => path.startsWith('private.')),
    `unprotected Astro original or derivative: ${remaining}`,
  );
});

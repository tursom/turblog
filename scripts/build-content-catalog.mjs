import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, join, relative, resolve, sep } from 'node:path';
import { load } from 'cheerio';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const mediaPattern =
  /\.(?:avif|gif|ico|jpe?g|png|svg|webp|mp4|webm|mp3|ogg|wav|pdf|zip|gz|txt|csv|epub)$/i;
const imagePattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

/** @param {string} directory @returns {Promise<string[]>} */
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not supported in content output: ${entry.name}`);
      if (entry.isDirectory()) {
        if (entry.name === '_internal') return [];
        return (await walk(join(directory, entry.name))).map((path) => `${entry.name}/${path}`);
      }
      return [entry.name];
    }),
  );
  return paths.flat().sort();
}

/** @param {unknown} value */
function validSlugs(value) {
  return (
    Array.isArray(value) &&
    value.every((slug) => typeof slug === 'string' && slugPattern.test(slug)) &&
    new Set(value).size === value.length
  );
}

/** @param {string} path */
function protectable(path) {
  return (
    mediaPattern.test(path) &&
    !/^\/favicon(?:[.-]|\/)/i.test(path) &&
    !/^\/(?:_internal|_content|_owner|posts|books|api)\//.test(path)
  );
}

/** @param {string} value @param {URL} base */
function localPath(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) return null;
  return decodeURIComponent(url.pathname);
}

/** @param {string} value */
function srcsetURLs(value) {
  // URL tokens may contain commas (notably data URLs); descriptors end at the next comma.
  const urls = [];
  let rest = value;
  while (rest.trim()) {
    rest = rest.replace(/^[\s,]+/, '');
    const token = /^\S+/.exec(rest)?.[0];
    if (!token) break;
    urls.push(token.replace(/,+$/, ''));
    rest = rest.slice(token.length);
    if (!token.endsWith(',')) rest = rest.replace(/^[^,]*(?:,|$)/, '');
  }
  return urls;
}

/** @param {string} path */
function imageFamily(path) {
  const stem = posix.basename(path, posix.extname(path));
  // Astro keeps the source basename (including Vite's source hash) before its transform hash.
  if (path.startsWith('/_astro/')) return `astro:${stem.replace(/_[A-Za-z0-9]+$/, '')}`;
  return `${posix.dirname(path)}/${stem.replace(/-\d+(?:x\d+)?$/, '')}`;
}

/**
 * @typedef {{path: string, ownerSlugs: string[] | null}} AssetReference
 * @typedef {{key: string, checksum: string, references: AssetReference[]}} ReferenceEntry
 * @typedef {{file: string, version: string, pages: Record<string, unknown>, nextPages: Record<string, ReferenceEntry>}} ReferenceCache
 * @typedef {{htmlFiles: number, parsedPages: number, reusedPages: number, cacheWarnings: string[], timings: Record<string, number>}} CatalogMetrics
 */

/** @param {string | Buffer} value */
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} path @returns {Promise<string>} */
async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT' || dirname(path) === path) throw error;
    // Cache directories may not exist yet; resolve symlinks in their existing ancestors.
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

/** @param {unknown} value @returns {value is AssetReference} */
function validReference(value) {
  return (
    record(value) &&
    typeof value.path === 'string' &&
    value.path.startsWith('/') &&
    protectable(value.path) &&
    !/[\\\s\x00-\x1f\x7f%?#]/u.test(value.path) &&
    posix.normalize(value.path) === value.path &&
    (value.ownerSlugs === null || validSlugs(value.ownerSlugs))
  );
}

/** @param {unknown} entry @param {string} key @returns {entry is ReferenceEntry} */
function reusable(entry, key) {
  return (
    record(entry) &&
    entry.key === key &&
    Array.isArray(entry.references) &&
    entry.references.every(validReference) &&
    entry.checksum === digest(JSON.stringify(entry.references))
  );
}

/** @param {string | undefined} cacheDir @param {CatalogMetrics} metrics @returns {Promise<ReferenceCache | null>} */
async function readReferenceCache(cacheDir, metrics) {
  if (!cacheDir) return null;
  let version;
  try {
    // Parser code and dependency changes invalidate interpretations, including local builds.
    const inputs = await Promise.all([
      readFile(new URL(import.meta.url)),
      readFile(new URL('../pnpm-lock.yaml', import.meta.url)),
    ]);
    version = digest(Buffer.concat(inputs));
  } catch {
    metrics.cacheWarnings.push('Reference cache disabled: cannot fingerprint parser inputs.');
    return null;
  }
  const file = join(cacheDir, 'content-catalog-references.json');
  /** @type {Record<string, unknown>} */
  let pages = {};
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (record(data) && data.version === version && record(data.pages)) pages = data.pages;
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT')
      metrics.cacheWarnings.push('Reference cache unreadable; reparsing HTML.');
  }
  return { file, version, pages, nextPages: Object.create(null) };
}

/** @param {ReferenceCache | null} cache @param {CatalogMetrics} metrics */
async function writeReferenceCache(cache, metrics) {
  if (!cache) return;
  const temporary = `${cache.file}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(cache.file, '..'), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: cache.version, pages: cache.nextPages }));
    await rename(temporary, cache.file);
  } catch {
    metrics.cacheWarnings.push('Reference cache could not be saved; build output is unaffected.');
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * @param {string} source
 * @param {string} page
 * @param {string | null} privateSlug
 * @param {boolean} ownerPage
 * @param {Set<string>} privatePosts
 * @param {URL} site
 * @returns {AssetReference[]}
 */
function parseAssetReferences(source, page, privateSlug, ownerPage, privatePosts, site) {
  const base = new URL(page, site);
  const html = load(source);
  /** @type {AssetReference[]} */
  const assets = [];
  html(
    'img[src], img[srcset], source[src], source[srcset], video[src], video[poster], audio[src], a[href], meta[property="og:image"], meta[name="twitter:image"]',
  ).each((_, element) => {
    const node = html(element);
    const references = ['src', 'poster', 'href', 'content'].flatMap((attribute) => {
      const value = node.attr(attribute);
      return value ? [value] : [];
    });
    const srcset = node.attr('srcset');
    if (srcset) references.push(...srcsetURLs(srcset));
    for (const value of references) {
      const path = localPath(value, base);
      if (!path) continue;
      if (!protectable(path)) {
        if (
          (privateSlug || ownerPage) &&
          (node.is('img, source, video, audio, meta') || node.is('a[download]')) &&
          !/^\/favicon(?:[.-]|\/)/i.test(path)
        ) {
          throw new Error(`Unsupported private local media URL ${path} referenced by ${page}`);
        }
        continue;
      }
      if (/[\\\s\x00-\x1f\x7f%?#]/u.test(path) || posix.normalize(path) !== path) {
        throw new Error(`Unsafe local asset URL: ${value}`);
      }
      /** @type {string[] | null} */
      let ownerSlugs = null;
      if (ownerPage) {
        // A cover can appear only in an owner list, not in the article detail.
        let parent = node;
        ownerSlugs = [];
        while (parent.length) {
          ownerSlugs = parent
            .find('a[href]')
            .addBack('a[href]')
            .toArray()
            .flatMap((link) => {
              const linkPath = localPath(html(link).attr('href') ?? '', base);
              const match = /^\/posts\/([^/]+)\/$/.exec(linkPath ?? '');
              return match && privatePosts.has(match[1]) ? [match[1]] : [];
            });
          if (ownerSlugs.length) break;
          parent = parent.parent();
        }
        ownerSlugs = [...new Set(ownerSlugs)];
      }
      assets.push({ path, ownerSlugs });
    }
  });
  return assets;
}

/**
 * @param {string} directory
 * @param {string[]} files
 * @param {Set<string>} privatePosts
 * @param {URL} site
 * @param {ReferenceCache | null} cache
 * @param {CatalogMetrics} metrics
 */
async function collectPrivateAssets(directory, files, privatePosts, site, cache, metrics) {
  const scanStart = performance.now();
  const available = new Set(files.map((file) => `/${file}`));
  /** @type {Map<string, Set<string>>} */
  const owners = new Map();
  const publicAssets = new Set();
  /** @type {Array<{path: string, slugs: string[]}>} */
  const ownerAssets = [];
  const ownerContext = [...privatePosts].sort();
  const htmlFiles = files.filter((file) => file.endsWith('.html'));
  metrics.htmlFiles = htmlFiles.length;
  for (const file of htmlFiles) {
    const page = `/${file.replace(/index\.html$/, '')}`;
    const slug = /^\/posts\/([^/]+)\/index\.html$/.exec(`/${file}`)?.[1];
    const privateSlug = slug && privatePosts.has(slug) ? slug : null;
    const ownerPage = page.startsWith('/_owner/');
    const source = await readFile(join(directory, file), 'utf8');
    const key = cache
      ? createHash('sha256')
          .update(JSON.stringify([page, site.origin, privateSlug, ownerPage ? ownerContext : null]))
          .update('\0')
          .update(source)
          .digest('hex')
      : '';
    const previous = cache?.pages[file];
    let references;
    if (reusable(previous, key)) {
      references = previous.references;
      metrics.reusedPages++;
    } else {
      references = parseAssetReferences(source, page, privateSlug, ownerPage, privatePosts, site);
      metrics.parsedPages++;
    }
    if (cache)
      cache.nextPages[file] = { key, checksum: digest(JSON.stringify(references)), references };
    // Re-evaluate existence, sharing and ownership against this build, even on cache hits.
    for (const { path, ownerSlugs } of references) {
      if (!privateSlug && !ownerPage) {
        publicAssets.add(path);
        continue;
      }
      if (!available.has(path))
        throw new Error(`Missing private local asset ${path} referenced by ${page}`);
      if (privateSlug) {
        const slugs = owners.get(path) ?? new Set();
        slugs.add(privateSlug);
        owners.set(path, slugs);
      } else {
        ownerAssets.push({ path, slugs: ownerSlugs ?? [] });
      }
    }
  }
  metrics.timings.html = performance.now() - scanStart;
  const assetStart = performance.now();
  for (const { path, slugs } of ownerAssets) {
    if (publicAssets.has(path)) continue;
    if (slugs.length !== 1) {
      if (owners.has(path)) continue;
      throw new Error(`Cannot determine private post owner for owner-list asset ${path}`);
    }
    const knownOwners = owners.get(path) ?? new Set();
    knownOwners.add(slugs[0]);
    owners.set(path, knownOwners);
  }
  if (!owners.size) {
    metrics.timings.assets = performance.now() - assetStart;
    return {};
  }

  // Include unused source copies and responsive derivatives, not just the selected HTML rendition.
  // Exact byte duplicates are also copies, regardless of their filename or directory.
  const assets = [...available].filter(protectable);
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  /** @param {string} key @param {string} path */
  const group = (key, path) => groups.set(key, [...(groups.get(key) ?? []), path]);
  for (const path of assets) {
    group(
      `bytes:${createHash('sha256')
        .update(await readFile(join(directory, path)))
        .digest('hex')}`,
      path,
    );
    if (imagePattern.test(path)) {
      group(`family:${imageFamily(path)}`, path);
      // Public-dir images transformed by Astro retain their unhashed source basename.
      const stem = posix.basename(path, posix.extname(path));
      group(
        `source:${path.startsWith('/_astro/') ? stem.replace(/_[A-Za-z0-9]+$/, '').replace(/\.[A-Za-z0-9_-]{6,}$/, '') : stem.replace(/-\d+(?:x\d+)?$/, '')}`,
        path,
      );
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, paths] of groups) {
      const slugs = new Set(paths.flatMap((path) => [...(owners.get(path) ?? [])]));
      if (key.startsWith('source:') && slugs.size) {
        const originals = paths.filter((path) => !path.startsWith('/_astro/'));
        const imported = paths.filter((path) => path.startsWith('/_astro/'));
        if (
          new Set(originals.map((path) => posix.dirname(path))).size > 1 ||
          new Set(imported.map(imageFamily)).size > 1
        ) {
          throw new Error(`Ambiguous private image source copies: ${paths.join(', ')}`);
        }
      }
      const shared = paths.some((path) => publicAssets.has(path));
      for (const path of paths) {
        if (slugs.size && (owners.get(path)?.size ?? 0) !== slugs.size) {
          owners.set(path, new Set(slugs));
          changed = true;
        }
        if (shared && !publicAssets.has(path)) {
          publicAssets.add(path);
          changed = true;
        }
      }
    }
  }
  metrics.timings.assets = performance.now() - assetStart;
  return Object.fromEntries(
    [...owners]
      .filter(([path]) => !publicAssets.has(path))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, slugs]) => [path, [...slugs].sort()]),
  );
}

/**
 * @param {string} directory
 * @param {{cacheDir?: string}} options
 * @returns {Promise<CatalogMetrics>}
 */
export async function buildContentCatalog(directory, { cacheDir } = {}) {
  const start = performance.now();
  /** @type {CatalogMetrics} */
  const metrics = { htmlFiles: 0, parsedPages: 0, reusedPages: 0, cacheWarnings: [], timings: {} };
  if (cacheDir) {
    const outputPath = await realpath(directory);
    try {
      cacheDir = await canonicalPath(resolve(cacheDir));
    } catch {
      metrics.cacheWarnings.push('Reference cache disabled: cannot resolve cache directory.');
      cacheDir = undefined;
    }
    if (cacheDir) {
      const path = relative(outputPath, cacheDir);
      if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)))
        throw new Error('Catalog cache must be outside build output');
    }
  }
  const cache = await readReferenceCache(cacheDir, metrics);
  metrics.timings.cache = performance.now() - start;
  const manifestStart = performance.now();
  const manifest = JSON.parse(await readFile(join(directory, 'book-access-manifest.json'), 'utf8'));
  if (manifest?.version !== 1 || !validSlugs(manifest.privateBooks))
    throw new Error('Invalid v1 book access manifest');
  const postManifest = JSON.parse(
    await readFile(join(directory, 'post-access-manifest.json'), 'utf8'),
  );
  if (
    postManifest?.version !== 1 ||
    !validSlugs(postManifest.privatePosts) ||
    !postManifest.privateAssets ||
    Array.isArray(postManifest.privateAssets) ||
    typeof postManifest.privateAssets !== 'object' ||
    Object.keys(postManifest.privateAssets).length ||
    Object.keys(postManifest).sort().join(',') !== 'privateAssets,privatePosts,version'
  ) {
    throw new Error('Invalid initial v1 post access manifest');
  }
  const privateBooks = new Set(manifest.privateBooks);
  /** @type {Set<string>} */
  const privatePosts = new Set(postManifest.privatePosts);
  metrics.timings.manifests = performance.now() - manifestStart;
  const walkStart = performance.now();
  const files = await walk(directory);
  metrics.timings.walk = performance.now() - walkStart;
  const sitemapStart = performance.now();
  const chunks = files.filter((name) => /^sitemap-\d+\.xml$/.test(name));
  if (chunks.length === 0) throw new Error('No generated sitemap chunks found');
  const documents = await Promise.all(
    chunks.map(async (name) => {
      const xml = load(await readFile(join(directory, name), 'utf8'), { xml: true });
      if (xml('urlset').length !== 1 || xml('urlset > url').length === 0)
        throw new Error(`Invalid sitemap chunk: ${name}`);
      return { name, xml };
    }),
  );
  const internal = load(documents[0].xml.xml(), { xml: true });
  for (const { xml } of documents.slice(1)) {
    xml('urlset > url').each((_, node) => {
      internal('urlset').append(xml.xml(node));
    });
  }
  const paths = new Set(
    internal('urlset > url > loc')
      .toArray()
      .map((node) => new URL(internal(node).text()).pathname),
  );
  for (const slug of privatePosts) {
    if (!paths.has(`/posts/${slug}/`) || !files.includes(`posts/${slug}/index.html`))
      throw new Error(`Missing canonical private post output: ${slug}`);
    if (
      files.some(
        (file) =>
          file === `posts/${slug}.html` ||
          (file.startsWith(`posts/${slug}/`) && file !== `posts/${slug}/index.html`),
      )
    )
      throw new Error(`Unexpected public files in private post output: ${slug}`);
  }
  metrics.timings.sitemap = performance.now() - sitemapStart;
  const privateAssets = await collectPrivateAssets(
    directory,
    files,
    privatePosts,
    new URL(internal('urlset > url > loc').first().text()),
    cache,
    metrics,
  );
  const writeStart = performance.now();
  for (const { xml } of documents) {
    xml('urlset > url').each((_, node) => {
      const pathname = decodeURIComponent(new URL(xml(node).children('loc').text()).pathname);
      const [, section, slug] = pathname.split('/');
      if (
        pathname.split('/').includes('_owner') ||
        (section === 'books' && privateBooks.has(slug)) ||
        (section === 'posts' && privatePosts.has(slug))
      )
        xml(node).remove();
    });
  }
  await mkdir(join(directory, '_internal'), { recursive: true });
  await writeFile(join(directory, '_internal/content-catalog.xml'), internal.xml());
  for (const slug of privatePosts) {
    await mkdir(join(directory, '_internal/posts', slug), { recursive: true });
    await rename(
      join(directory, 'posts', slug, 'index.html'),
      join(directory, '_internal/posts', slug, 'index.html'),
    );
    await rmdir(join(directory, 'posts', slug));
  }
  for (const path of Object.keys(privateAssets)) {
    const destination = join(directory, '_internal/assets', path);
    await mkdir(posix.dirname(destination), { recursive: true });
    await rename(join(directory, path), destination);
  }
  await writeFile(
    join(directory, 'post-access-manifest.json'),
    `${JSON.stringify({ version: 1, privatePosts: [...privatePosts].sort(), privateAssets }, null, 2)}\n`,
  );
  await Promise.all(documents.map(({ name, xml }) => writeFile(join(directory, name), xml.xml())));
  metrics.timings.write = performance.now() - writeStart;
  const cacheStart = performance.now();
  await writeReferenceCache(cache, metrics);
  metrics.timings.cache += performance.now() - cacheStart;
  metrics.timings.total = performance.now() - start;
  return metrics;
}

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { parseFrontmatter } from '@astrojs/markdown-remark';
import { load, type CheerioAPI } from 'cheerio';
import { expect, test } from 'playwright/test';

const distDirectory = resolve('dist');
const postsDirectory = resolve('src/content/posts');
const pageSize = 10;

type PostMetadata = {
  slug: string;
  title: string;
  summary: string;
  publishedAt: string | Date;
  tags: string[];
  private?: boolean;
};

async function loadPosts(): Promise<PostMetadata[]> {
  const paths = await readdir(postsDirectory, { recursive: true });
  return Promise.all(
    paths
      .filter((path) => path.endsWith('.md'))
      .map(async (path) => {
        const { frontmatter } = parseFrontmatter(
          await readFile(resolve(postsDirectory, path), 'utf8'),
        );
        return frontmatter as PostMetadata;
      }),
  );
}

function tagPath(tag: string) {
  const slug = tag
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `/tags/${encodeURIComponent(slug)}/`;
}

async function readPage(publicPath: string, owner = false) {
  const path = `${owner ? '/_owner' : ''}${publicPath}index.html`;
  return load(await readFile(resolve(distDirectory, `.${decodeURIComponent(path)}`), 'utf8'));
}

function expectListingChrome($: CheerioAPI, publicPath: string, owner: boolean) {
  const canonical = $('link[rel="canonical"]').attr('href');
  expect(canonical).toBeTruthy();
  expect(new URL(canonical!).pathname).toBe(publicPath);
  expect($('meta[name="robots"]').attr('content')?.includes('noindex') ?? false).toBe(owner);
  expect($('a[href="/_access/?return_to=/"]').text()).toContain('输入密钥');
  expect($('a[href^="/_owner"], a[href^="/_internal"]').length).toBe(0);
  const activePath = publicPath.startsWith('/archive/')
    ? '/archive/'
    : publicPath.startsWith('/tags/')
      ? '/tags/'
      : '/';
  expect($('.sidebar-nav a[aria-current="page"]').attr('href')).toBe(activePath);
}

async function expectPaginatedListing(basePath: string, posts: PostMetadata[], owner: boolean) {
  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
  const hrefs: string[] = [];
  for (let page = 1; page <= totalPages; page++) {
    const publicPath = page === 1 ? basePath : `${basePath}${page}/`;
    const $ = await readPage(publicPath, owner);
    expectListingChrome($, publicPath, owner);
    const links = $('.post-card h3 a')
      .toArray()
      .map((link) => $(link).attr('href')!);
    expect(links).toHaveLength(Math.min(pageSize, posts.length - (page - 1) * pageSize));
    hrefs.push(...links);
    const paginationLinks = $('.pagination a')
      .toArray()
      .map((link) => $(link).attr('href'));
    expect(paginationLinks).toEqual([
      ...(page > 1 ? [page === 2 ? basePath : `${basePath}${page - 1}/`] : []),
      ...(page < totalPages ? [`${basePath}${page + 1}/`] : []),
    ]);
  }
  expect([...hrefs].sort()).toEqual(posts.map((post) => `/posts/${post.slug}/`).sort());
  const dates = hrefs.map((href) => {
    const post = posts.find((post) => href === `/posts/${post.slug}/`)!;
    return new Date(post.publishedAt).valueOf();
  });
  expect(dates).toEqual([...dates].sort((a, b) => b - a));
}

test('private article HTML exists only in the internal post directory', async () => {
  const privatePosts = (await loadPosts()).filter((post) => post.private === true);
  const manifest = JSON.parse(
    await readFile(resolve(distDirectory, 'post-access-manifest.json'), 'utf8'),
  ) as { version: number; privatePosts: string[] };
  expect(manifest.version).toBe(1);
  expect(manifest.privatePosts).toEqual(privatePosts.map((post) => post.slug).sort());
  const paths = (await readdir(distDirectory, { recursive: true })).map((path) =>
    path.split(sep).join('/'),
  );

  for (const post of privatePosts) {
    await expect(
      stat(resolve(distDirectory, 'posts', post.slug, 'index.html')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const internalPath = `_internal/posts/${post.slug}/index.html`;
    expect(paths.filter((path) => path.endsWith(`posts/${post.slug}/index.html`))).toEqual([
      internalPath,
    ]);
    const $ = load(await readFile(resolve(distDirectory, internalPath), 'utf8'));
    expect($('.article-header > h1').text()).toBe(post.title);
    expect($('.article-summary').text()).toBe(post.summary);
    expect($('.prose').text().trim().length).toBeGreaterThan(0);
    expect($('meta[name="robots"]').attr('content')).toContain('noindex');
    expect(new URL($('link[rel="canonical"]').attr('href')!).pathname).toBe(`/posts/${post.slug}/`);
    expect($('[data-book-share]').text()).toBe('复制本文分享链接');
    expect($('a[href^="https://github.com/tursom/turblog/issues/new"]').length).toBe(0);
  }
});

test('public artifacts, RSS and sitemap contain no private post metadata', async () => {
  const privatePosts = (await loadPosts()).filter((post) => post.private === true);
  const paths = await readdir(distDirectory, { recursive: true });
  const textPaths = paths.filter(
    (path) =>
      /\.(?:html|xml|json|[cm]?js|map|txt)$/.test(path) &&
      // This operational manifest is explicitly blocked by both nginx configurations.
      path !== 'post-access-manifest.json' &&
      !path.split(sep).some((segment) => segment === '_internal' || segment === '_owner'),
  );

  expect(textPaths).toContain('rss.xml');
  expect(textPaths.some((path) => path.startsWith('sitemap'))).toBe(true);
  expect(textPaths).toContain('archive/index.html');
  expect(textPaths).toContain('tags/index.html');

  for (const path of textPaths) {
    const content = await readFile(resolve(distDirectory, path), 'utf8');
    for (const post of privatePosts) {
      for (const value of [post.slug, post.title, post.summary]) {
        expect(content, `${path} exposes private metadata`).not.toContain(value);
        expect(content, `${path} exposes encoded private metadata`).not.toContain(
          encodeURIComponent(value),
        );
      }
    }
    if (path.startsWith('sitemap') || path === 'rss.xml') {
      expect(content).not.toContain('/_owner/');
      expect(content).not.toContain('/_internal/');
      expect(content).not.toContain('post-access-manifest.json');
    }
  }
});

for (const owner of [false, true]) {
  test(`${owner ? 'owner' : 'public'} home, archive and tag pages match source metadata`, async () => {
    const posts = (await loadPosts()).filter((post) => owner || post.private !== true);
    const $ = await readPage('/', owner);
    expectListingChrome($, '/', owner);
    const homeLinks = $('.featured-post h2 a, .post-card h3 a')
      .toArray()
      .map((link) => $(link).attr('href'));
    expect(homeLinks).toHaveLength(Math.min(posts.length, pageSize));
    expect(new Set(homeLinks).size).toBe(homeLinks.length);
    const homeDates = homeLinks.map((href) => {
      const post = posts.find((post) => href === `/posts/${post.slug}/`);
      expect(post, `unexpected home post ${href}`).toBeDefined();
      return new Date(post!.publishedAt).valueOf();
    });
    expect(homeDates).toEqual(
      posts
        .map((post) => new Date(post.publishedAt).valueOf())
        .sort((a, b) => b - a)
        .slice(0, pageSize),
    );

    await expectPaginatedListing('/archive/', posts, owner);
    const archive = await readPage('/archive/', owner);
    expect(archive('.page-intro p').text()).toContain(`共 ${posts.length} 篇`);
    const tags = [...new Set(posts.flatMap((post) => post.tags))];
    const index = await readPage('/tags/', owner);
    expectListingChrome(index, '/tags/', owner);
    expect(
      index('.tag-index a')
        .toArray()
        .map((link) => index(link).attr('href'))
        .sort(),
    ).toEqual(tags.map(tagPath).sort());
    for (const tag of tags) {
      const tagged = posts.filter((post) => post.tags.includes(tag));
      expect(index(`.tag-index a[href="${tagPath(tag)}"] small`).text()).toBe(
        `${tagged.length} 篇`,
      );
      await expectPaginatedListing(tagPath(tag), tagged, owner);
    }
  });
}

test('posts without a private flag remain published and syndicated', async () => {
  const publicPosts = (await loadPosts()).filter((post) => post.private !== true);
  expect(publicPosts.some((post) => post.private === undefined)).toBe(true);
  const feed = await readFile(resolve(distDirectory, 'rss.xml'), 'utf8');

  for (const post of publicPosts) {
    const $ = await readPage(`/posts/${post.slug}/`);
    expect($('.article-header > h1').text()).toBe(post.title);
    expect($('meta[name="robots"]').attr('content') ?? '').not.toContain('noindex');
    expect($('a[href^="https://github.com/tursom/turblog/issues/new"]').length).toBe(1);
    expect(feed).toContain(`/posts/${post.slug}/`);
  }
});

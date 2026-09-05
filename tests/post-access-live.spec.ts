import { readFile, readdir } from 'node:fs/promises';
import { parseFrontmatter } from '@astrojs/markdown-remark';
import { expect, test } from 'playwright/test';

const baseURL = process.env.TURBLOG_ACCESS_TEST_URL;
const password = process.env.TURBLOG_ACCESS_TEST_PASSWORD;
const posts = await Promise.all(
  (await readdir('src/content/posts'))
    .filter((file) => file.endsWith('.md'))
    .map(
      async (file) =>
        parseFrontmatter(await readFile(`src/content/posts/${file}`, 'utf8')).frontmatter,
    ),
);
const privatePost = posts
  .filter((post) => post.private === true)
  .sort((a, b) => new Date(b.publishedAt).valueOf() - new Date(a.publishedAt).valueOf())[0];
const postPath = `/posts/${privatePost?.slug}/`;

test.use({ baseURL });
test.skip(
  !baseURL || !password || !privatePost,
  'Requires a running privacy stack, test password and private post',
);

test('one key unlocks private blogs in home, archive, tags, and the book shelf', async ({
  page,
}) => {
  for (const path of ['/', '/archive/', '/tags/']) {
    const response = await page.goto(path);
    expect(response?.headers()['cache-control']).toBe('no-store');
    await expect(page.locator('body')).not.toContainText(privatePost.title);
  }
  for (const path of [
    postPath,
    `${postPath}index.html`,
    '/_owner/',
    `/_content${postPath}`,
    '/post-access-manifest.json',
  ]) {
    expect((await page.request.get(path)).status()).toBe(404);
  }
  await page.goto('/');
  await page.getByRole('link', { name: '输入密钥', exact: true }).click();
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.locator(`a[href="${postPath}"]`).first()).toBeVisible();
  for (const path of ['/archive/', '/tags/']) {
    await page.goto(path);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  }
  const tagPath = `/tags/${encodeURIComponent(
    String(privatePost.tags[0])
      .trim()
      .toLowerCase()
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, '-'),
  )}/`;
  await page.goto(tagPath);
  await expect(page.locator(`a[href="${postPath}"]`).first()).toBeVisible();
  const article = await page.goto(postPath);
  expect(article?.status()).toBe(200);
  expect(article?.headers()['cache-control']).toBe('no-store');
  await expect(page.locator('h1')).toHaveText(privatePost.title);
  await expect(page.getByRole('link', { name: '提交勘误' })).toHaveCount(0);
  await page.goto('/books/');
  await expect(page.locator('a[href="/books/raft/"]').first()).toBeVisible();
  const feed = await page.request.get('/rss.xml');
  expect(await feed.text()).not.toContain(privatePost.slug);
});

test('private blog sharing stays article-scoped and works across a fresh browser', async ({
  page,
  browser,
}) => {
  await page.goto('/books/_access/');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/books/`);
  await page.goto(postPath);
  await expect(page.locator('h1')).toHaveText(privatePost.title);
  const response = await page.request.post('/books/_access/share', { data: { path: postPath } });
  expect(response.status()).toBe(200);
  const { token } = await response.json();
  const guest = await browser.newContext({ baseURL });
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto(`${postPath}#access=${token}`);
    await expect(guestPage).toHaveURL(`${baseURL}${postPath}`);
    await expect(guestPage.locator('h1')).toHaveText(privatePost.title);
    expect((await guest.request.get('/books/raft/')).status()).toBe(404);
    for (const path of ['/', '/archive/']) {
      await guestPage.goto(path);
      await expect(guestPage.locator('body')).not.toContainText(privatePost.title);
    }
    const metrics = await guest.request.post('/api/v1/analytics/metrics/query', {
      data: {
        metric: 'article_unique_views',
        subject_type: 'article',
        subject_ids: [privatePost.slug],
      },
    });
    expect((await metrics.json()).values).toHaveProperty(privatePost.slug);
  } finally {
    await guest.close();
  }
});

test('unlocked blog views fit desktop and mobile viewports', async ({ page }) => {
  await page.goto('/_access/');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, path] of [
      ['home', '/'],
      ['archive', '/archive/'],
      ['article', postPath],
    ]) {
      await page.goto(path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `/tmp/turblog-post-${label}-${width}.png` });
    }
  }
});

test('global login cannot redirect outside the site', async ({ page }) => {
  await page.goto('/_access/?return_to=https://example.com/');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/`);
});

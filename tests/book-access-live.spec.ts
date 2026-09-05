import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { expect, test } from 'playwright/test';

const ownerGroupCount = load(await readFile('dist/books/_owner/index.html', 'utf8'))(
  '[data-book-group]',
).length;

const baseURL = process.env.TURBLOG_ACCESS_TEST_URL;
const password = process.env.TURBLOG_ACCESS_TEST_PASSWORD;

test.use({ baseURL });
test.skip(!baseURL || !password, 'Requires a running Go/Nginx stack and test password');

const bookPath = '/books/daode-yu-fazhi-7-shang/';
const chapterPath = `${bookPath}daode-yu-fazhi-7-shang-lesson-01/`;
const adjacentPath = `${bookPath}daode-yu-fazhi-7-shang-lesson-02/`;

test('anonymous browsing, global unlock, and scoped sharing through the real server', async ({
  page,
  browser,
}) => {
  await page.goto('/books/');
  await expect(page.locator('[data-book-group]')).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText('道德与法治');
  expect((await page.request.get(bookPath)).status()).toBe(404);
  expect((await page.request.get('/books/_owner/index.html')).status()).toBe(404);
  expect((await page.request.get('/images/books/daode-yu-fazhi-7-shang/cover.jpg')).status()).toBe(
    404,
  );

  await page.locator('.page-intro').getByRole('link', { name: '输入密钥' }).click();
  await page.locator('#password').fill('wrong-test-key');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('不正确');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/books/`);
  await expect(page.locator('[data-book-group]')).toHaveCount(ownerGroupCount);
  await expect(page.locator('[data-book-group]', { hasText: '道德与法治' })).toBeVisible();
  expect((await page.request.get('/images/books/daode-yu-fazhi-7-shang/cover.jpg')).status()).toBe(
    200,
  );

  for (const [path, wholeBook] of [
    [bookPath, true],
    [chapterPath, false],
  ] as const) {
    const share = await page.request.post('/books/_access/share', { data: { path } });
    expect(share.status()).toBe(200);
    const { token } = await share.json();
    const guest = await browser.newContext({ baseURL });
    try {
      const guestPage = await guest.newPage();
      await guestPage.goto(`${path}#access=${token}`);
      await expect(guestPage).toHaveURL(`${baseURL}${path}`);
      await expect(guestPage.locator('h1')).not.toContainText('不存在');
      expect((await guest.request.get(adjacentPath)).status()).toBe(wholeBook ? 200 : 404);
      expect((await guest.request.get('/books/raft/')).status()).toBe(404);
      await guestPage.goto('/books/');
      await expect(guestPage.locator('[data-book-group]')).toHaveCount(3);
      await expect(guestPage.locator('[data-continue-reading]')).toBeHidden();
      expect((await guest.request.post('/books/_access/share', { data: { path } })).status()).toBe(
        403,
      );
    } finally {
      await guest.close();
    }
  }
});

test('chapter shares retain inline images and independent grants', async ({ page, browser }) => {
  await page.goto('/books/_access/');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/books/`);
  const guest = await browser.newContext({ baseURL });
  try {
    const guestPage = await guest.newPage();
    for (const path of ['/books/wuaa-xiao-ye/chapter-01/', chapterPath]) {
      const response = await page.request.post('/books/_access/share', { data: { path } });
      expect(response.status()).toBe(200);
      const { token } = await response.json();
      await guestPage.goto(`${path}#access=${token}`);
      await expect(guestPage).toHaveURL(`${baseURL}${path}`);
      await expect(guestPage.locator('[data-book-share]')).toBeVisible();
    }
    await guestPage.goto('/books/wuaa-xiao-ye/chapter-01/');
    const image = guestPage.locator('.prose img').first();
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    expect((await guest.request.get('/books/wuaa-xiao-ye/chapter-02/')).status()).toBe(404);
    expect((await guest.request.get(chapterPath)).status()).toBe(200);
  } finally {
    await guest.close();
  }
});

test('public and unlocked shelves fit desktop and mobile viewports', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/books/');
    await expect(page.locator('[data-book-group]')).toHaveCount(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/turblog-private-public-${width}.png`, fullPage: true });
  }
  await page.goto('/books/_access/');
  await page.locator('#password').fill(password!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(`${baseURL}/books/`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('[data-book-group]')).toHaveCount(ownerGroupCount);
    for (const image of await page.locator('[data-book-group] img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/turblog-private-owner-${width}.png`, fullPage: true });
  }
});

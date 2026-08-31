import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { expect, test, type Page } from 'playwright/test';

const baseUrl = 'http://turblog.test';
const distDirectory = resolve('dist');
const apiPath = '/api/v1/analytics/metrics/query';

async function serveBuiltSite(page: Page) {
  const requests: Array<{ metric: string; subjectType: string; subjectIds: string[] }> = [];
  await page.route(`${baseUrl}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === apiPath) {
      const payload = route.request().postDataJSON() as {
        metric: string;
        subject_type: string;
        subject_ids: string[];
      };
      requests.push({
        metric: payload.metric,
        subjectType: payload.subject_type,
        subjectIds: payload.subject_ids,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          metric: payload.metric,
          values: Object.fromEntries(payload.subject_ids.map((id) => [id, 3])),
          unknown: [],
        }),
      });
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const filePath = resolve(distDirectory, `.${relativePath}`);
    if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) {
      await route.fulfill({ status: 404 });
      return;
    }
    try {
      await route.fulfill({ status: 200, body: await readFile(filePath) });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  return requests;
}

test('book shelf and chapter pages stay separate from ordinary posts', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  await expect(page.locator('h1')).toHaveText('图书');
  await expect(page.getByRole('link', { name: '枪炮、病菌与钢铁', exact: true })).toHaveCount(1);
  await expect(page.locator('a[href="/posts/go-atomic-generics/"]')).toHaveCount(0);
});

test('Capital offers Chinese and German editions with parallel chapter links', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  await expect(page.getByRole('link', { name: '资本论', exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Das Kapital', exact: true })).toHaveCount(1);

  await page.goto(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);
  await expect(page.locator('h1')).toHaveText('第一章 商品');
  await expect(page.getByRole('link', { name: '阅读德文原文' })).toHaveAttribute(
    'href',
    '/books/capital-de/volume-01-chapter-01-de/',
  );
});

test('book chapter has toc navigation and its own metric', async ({ page }) => {
  const requests = await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/guns-germs-steel/chapter-01/`);

  await expect(page.locator('h1')).toHaveText('第一章 走上起跑线');
  await expect(page.locator('[data-book-chapter-views]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('[data-book-chapter-views]')).toHaveText('3 次访问');
  await expect(page.locator('a[href="/books/guns-germs-steel/chapter-02/"]')).toHaveCount(3);
  expect(requests).toEqual([
    {
      metric: 'book_chapter_unique_views',
      subjectType: 'book_chapter',
      subjectIds: ['guns-germs-steel/chapter-01'],
    },
  ]);
});

test('ordinary rss does not include book chapters', async ({ page }) => {
  await serveBuiltSite(page);
  const response = await page.goto(`${baseUrl}/rss.xml`);
  expect(response?.ok()).toBe(true);
  await expect(page.locator('body')).not.toContainText('枪炮、病菌与钢铁');
});

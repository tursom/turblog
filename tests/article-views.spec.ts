import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

const baseUrl = 'http://turblog.test';
const apiPath = '/api/v1/analytics/metrics/query';
const distDirectory = resolve('dist');

type MetricsMode = 'success' | 'unknown' | 'error';

async function serveBuiltSite(page: Page, mode: MetricsMode = 'success') {
  const requests: string[][] = [];
  await page.route(`${baseUrl}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === apiPath) {
      const payload = request.postDataJSON() as { subject_ids: string[] };
      requests.push(payload.subject_ids);
      if (mode === 'error') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return;
      }
      const unknown = mode === 'unknown' ? payload.subject_ids.slice(0, 1) : [];
      const values = Object.fromEntries(
        payload.subject_ids
          .filter((slug) => !unknown.includes(slug))
          .map((slug, index) => [slug, index]),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ metric: 'article_unique_views', values, unknown }),
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
      const body = await readFile(filePath);
      await route.fulfill({ status: 200, body });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  return requests;
}

for (const path of ['/', '/archive/', '/tags/go/', '/posts/go-atomic-generics/']) {
  test(`${path} batches every visible article count into one request`, async ({ page }) => {
    const requests = await serveBuiltSite(page);
    await page.goto(`${baseUrl}${path}`);

    const counters = page.locator('[data-article-views]');
    await expect(counters.first()).toHaveAttribute('data-state', 'ready');
    const slugs = await counters.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-article-views')!),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual([...new Set(slugs)]);
    expect(await counters.allTextContents()).toEqual(slugs.map((_, index) => `${index} 次访问`));
  });
}

test('unknown articles keep the unavailable fallback', async ({ page }) => {
  const requests = await serveBuiltSite(page, 'unknown');
  await page.goto(`${baseUrl}/archive/`);

  const unknownCounter = page.locator(`[data-article-views="${requests[0][0]}"]`);
  await expect(unknownCounter).toHaveAttribute('data-state', 'error');
  await expect(unknownCounter).toHaveText('— 次访问');
  await expect(page.locator('[data-article-views][data-state="ready"]').first()).toContainText(
    '次访问',
  );
  expect(requests).toHaveLength(1);
});

test('service errors leave every count unavailable', async ({ page }) => {
  const requests = await serveBuiltSite(page, 'error');
  await page.goto(`${baseUrl}/archive/`);

  const counters = page.locator('[data-article-views]');
  await expect(counters.first()).toHaveAttribute('data-state', 'error');
  expect(await counters.allTextContents()).toEqual(Array(await counters.count()).fill('— 次访问'));
  expect(requests).toHaveLength(1);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`view counts fit the post metadata on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await serveBuiltSite(page);
    await page.goto(`${baseUrl}/archive/`);
    const counter = page.locator('[data-article-views]').first();
    await expect(counter).toHaveAttribute('data-state', 'ready');

    const layout = await counter.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return {
        insideParent: box.left >= parent.left && box.right <= parent.right,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(layout.insideParent).toBe(true);
    expect(layout.documentWidth).toBe(layout.viewportWidth);
  });
}

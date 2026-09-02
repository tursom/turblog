import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { expect, test, type Page } from 'playwright/test';
import rehypeLegacyFootnoteAnchors from '../src/lib/rehype-legacy-footnote-anchors.mjs';

const baseUrl = 'http://turblog.test';
const distDirectory = resolve('dist');
const apiPath = '/api/v1/analytics/metrics/query';

const privateBookSlugs = [
  'three-body',
  'three-body-dark-forest',
  'three-body-deaths-end',
  'raft',
  'raft-zh',
  'timelike-infinity',
  'timelike-infinity-zh',
  'flux',
  'flux-zh',
  'ring',
  'ring-zh',
  'vacuum-diagrams',
  'vacuum-diagrams-zh',
  'mayflower-ii',
  'mayflower-ii-zh',
  'xeelee-endurance',
  'xeelee-endurance-zh',
  'xeelee-vengeance',
  'xeelee-vengeance-zh',
  'xeelee-redemption',
  'xeelee-redemption-zh',
  'xeelee-raft',
  'si-ren-jian-1',
  'daode-yu-fazhi-7-shang',
  'daode-yu-fazhi-7-xia',
  'daode-yu-fazhi-8-shang',
  'daode-yu-fazhi-8-xia',
  'daode-yu-fazhi-9-shang',
  'daode-yu-fazhi-9-xia',
  'sixiang-zhengzhi-bixiu-1',
  'sixiang-zhengzhi-bixiu-2',
  'sixiang-zhengzhi-bixiu-3',
  'sixiang-zhengzhi-bixiu-4',
  'sixiang-zhengzhi-xuanzexing-bixiu-1',
  'sixiang-zhengzhi-xuanzexing-bixiu-2',
  'sixiang-zhengzhi-xuanzexing-bixiu-3',
];

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

test('book access manifest is generated from private book metadata', async () => {
  const manifest = JSON.parse(
    await readFile(resolve(distDirectory, 'book-access-manifest.json'), 'utf8'),
  ) as { version: number; privateBooks: string[] };

  expect(manifest.version).toBe(1);
  expect(manifest.privateBooks).toEqual([...privateBookSlugs].sort());
  expect(manifest.privateBooks).not.toContain('guns-germs-steel');

  const sitemap = await readFile(resolve(distDirectory, 'sitemap-0.xml'), 'utf8');
  expect(sitemap).not.toContain('book-access-manifest.json');
});

test('private chapter owner can put an exact share token in the URL', async ({ page }) => {
  await serveBuiltSite(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(text: string) {
          (window as typeof window & { copiedShareLink?: string }).copiedShareLink = text;
          return Promise.resolve();
        },
      },
    });
  });
  const chapterPath = '/books/daode-yu-fazhi-7-shang/daode-yu-fazhi-7-shang-lesson-01/';
  const token = 'chapter-specific-token';
  let requestedPath = '';
  await page.route(`${baseUrl}/books/_access/share`, async (route) => {
    requestedPath = (route.request().postDataJSON() as { path: string }).path;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token }),
    });
  });

  await page.goto(`${baseUrl}${chapterPath}`);
  await page.getByRole('button', { name: '复制本章分享链接' }).click();

  await expect(page).toHaveURL(`${baseUrl}${chapterPath}#access=${token}`);
  await expect(page.locator('[data-book-share-status]')).toHaveText('链接已复制');
  expect(requestedPath).toBe(chapterPath);
  expect(
    await page.evaluate(
      () => (window as typeof window & { copiedShareLink?: string }).copiedShareLink,
    ),
  ).toBe(`${baseUrl}${chapterPath}#access=${token}`);

  await page.goto(`${baseUrl}/books/guns-germs-steel/chapter-01/`);
  await expect(page.getByRole('button', { name: '复制本章分享链接' })).toHaveCount(0);
});

test('book shelf groups series and filters books locally', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  await expect(page.locator('h1')).toHaveText('图书');
  await expect(page.locator('[data-book-group]')).toHaveCount(8);
  await expect(page.getByRole('link', { name: '枪炮、病菌与钢铁', exact: true })).toHaveCount(1);
  await expect(page.locator('a[href="/posts/go-atomic-generics/"]')).toHaveCount(0);

  const textbookSeries = page.locator('[data-book-group]', { hasText: '道德与法治' });
  await expect(textbookSeries.locator('.book-edition-list li')).toHaveCount(6);

  const xeeleeSeries = page.locator(
    '[data-book-group][aria-labelledby="book-group-xeelee-sequence"]',
  );
  await expect(xeeleeSeries.locator('.book-group-count')).toHaveText('10 部');
  await expect(xeeleeSeries.locator('.book-edition-list a > span')).toHaveText([
    'Raft',
    'Timelike Infinity',
    'Flux',
    'Ring',
    'Vacuum Diagrams',
    'Mayflower II',
    'Xeelee: Endurance',
    'Xeelee: Vengeance',
    'Xeelee: Redemption',
    'Raft (Short Story)',
  ]);

  const search = page.getByRole('searchbox', { name: '搜索图书' });
  await search.fill('德文原文');
  await expect(page.locator('[data-book-group]:visible')).toHaveCount(1);
  await expect(page.getByText('1 组', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Das Kapital，Drei Bände/ })).toBeVisible();

  await search.fill('');
  await page.getByRole('button', { name: '教材', exact: true }).click();
  await expect(page.locator('[data-book-group]:visible')).toHaveCount(2);
  await expect(page.getByText('2 组', { exact: true })).toBeVisible();
});

test('book contents can collapse volumes and filter chapter titles', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/mao-selected-works/`);

  await expect(page.locator('.book-toc-volume')).toHaveCount(5);
  await expect(page.locator('.book-toc-volume').first()).toHaveAttribute('open', '');

  await page.getByRole('searchbox', { name: '筛选本书目录' }).fill('中国社会各阶级的分析');
  await expect(page.locator('[data-book-toc-item]:visible')).toHaveCount(1);
  await expect(page.locator('[data-book-toc-count]')).toHaveText('1 项');
});

test('last opened book chapter appears on the shelf', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/guns-germs-steel/chapter-01/`);
  await page.goto(`${baseUrl}/books/`);

  const recent = page.locator('[data-continue-reading]');
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('枪炮、病菌与钢铁');
  await expect(recent.locator('a')).toHaveAttribute('href', '/books/guns-germs-steel/chapter-01/');
});

test('Capital offers Chinese and German editions with parallel chapter links', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  await expect(page.getByRole('link', { name: /资本论，三卷本 · 中文译文/ })).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Das Kapital，Drei Bände/ })).toHaveCount(1);

  await page.goto(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);
  await expect(page.locator('h1')).toHaveText('第一章 商品');
  await expect(page.getByRole('link', { name: '阅读德文原文' })).toHaveAttribute(
    'href',
    '/books/capital-de/volume-01-chapter-01-de/',
  );
});

test('Raft offers bidirectional English and Chinese chapter links', async ({ page }) => {
  await serveBuiltSite(page);

  await page.goto(`${baseUrl}/books/raft/raft-acknowledgment/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/raft-zh/raft-acknowledgment-zh/',
  );

  await page.goto(`${baseUrl}/books/raft-zh/raft-acknowledgment-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('致谢');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/raft/raft-acknowledgment/',
  );
  await expect(page.locator('.prose')).toContainText('拉里·尼文');

  await page.goto(`${baseUrl}/books/raft/raft-chapter-01/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/raft-zh/raft-chapter-01-zh/',
  );

  await page.goto(`${baseUrl}/books/raft-zh/raft-chapter-01-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('第1章');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/raft/raft-chapter-01/',
  );
  await expect(page.locator('.prose')).toContainText('铸造厂发生内爆');

  await page.goto(`${baseUrl}/books/raft/raft-chapter-02/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/raft-zh/raft-chapter-02-zh/',
  );

  await page.goto(`${baseUrl}/books/raft-zh/raft-chapter-02-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('第2章');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/raft/raft-chapter-02/',
  );

  await page.goto(`${baseUrl}/books/raft-zh/`);
  await expect(page.locator('.book-toc a')).toHaveCount(17);

  await page.goto(`${baseUrl}/books/raft/raft-chapter-16/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/raft-zh/raft-chapter-16-zh/',
  );

  await page.goto(`${baseUrl}/books/raft-zh/raft-chapter-16-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('第16章');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/raft/raft-chapter-16/',
  );
});

test('Timelike Infinity offers complete bidirectional Chinese links', async ({ page }) => {
  await serveBuiltSite(page);

  await page.goto(`${baseUrl}/books/timelike-infinity/timelike-infinity-dedication/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/timelike-infinity-zh/timelike-infinity-dedication-zh/',
  );

  await page.goto(`${baseUrl}/books/timelike-infinity-zh/timelike-infinity-dedication-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('献词');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/timelike-infinity/timelike-infinity-dedication/',
  );

  await page.goto(`${baseUrl}/books/timelike-infinity/timelike-infinity-chapter-01/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/timelike-infinity-zh/timelike-infinity-chapter-01-zh/',
  );

  await page.goto(`${baseUrl}/books/timelike-infinity-zh/`);
  await expect(page.locator('.book-toc a')).toHaveCount(17);

  await page.goto(`${baseUrl}/books/timelike-infinity/timelike-infinity-chapter-16/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/timelike-infinity-zh/timelike-infinity-chapter-16-zh/',
  );

  await page.goto(`${baseUrl}/books/timelike-infinity-zh/timelike-infinity-chapter-16-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('第16章');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/timelike-infinity/timelike-infinity-chapter-16/',
  );
});

test('Flux offers complete bidirectional Chinese links', async ({ page }) => {
  await serveBuiltSite(page);

  await page.goto(`${baseUrl}/books/flux/flux-xeelee-sequence-book-3/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/flux-zh/flux-xeelee-sequence-book-3-zh/',
  );

  await page.goto(`${baseUrl}/books/flux-zh/flux-xeelee-sequence-book-3-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('卷首');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/flux/flux-xeelee-sequence-book-3/',
  );

  await page.goto(`${baseUrl}/books/flux/flux-chapter-01/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/flux-zh/flux-chapter-01-zh/',
  );

  await page.goto(`${baseUrl}/books/flux-zh/`);
  await expect(page.locator('.book-toc a')).toHaveCount(30);

  await page.goto(`${baseUrl}/books/flux/flux-chapter-29/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/flux-zh/flux-chapter-29-zh/',
  );

  await page.goto(`${baseUrl}/books/flux-zh/flux-chapter-29-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('第29章');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/flux/flux-chapter-29/',
  );
});

test('Ring offers complete bidirectional Chinese links', async ({ page }) => {
  await serveBuiltSite(page);

  await page.goto(`${baseUrl}/books/ring/ring-ring-by-stephen-baxter/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/ring-zh/ring-ring-by-stephen-baxter-zh/',
  );

  await page.goto(`${baseUrl}/books/ring-zh/ring-ring-by-stephen-baxter-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('献词');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/ring/ring-ring-by-stephen-baxter/',
  );

  await page.goto(`${baseUrl}/books/ring/ring-chapter-01/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/ring-zh/ring-chapter-01-zh/',
  );

  await page.goto(`${baseUrl}/books/ring-zh/`);
  await expect(page.locator('.book-toc a')).toHaveCount(38);

  await page.goto(`${baseUrl}/books/ring/ring-timeline/`);
  await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
    'href',
    '/books/ring-zh/ring-timeline-zh/',
  );

  await page.goto(`${baseUrl}/books/ring-zh/ring-timeline-zh/`);
  await expect(page.locator('.article-header h1')).toHaveText('年表');
  await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
    'href',
    '/books/ring/ring-timeline/',
  );
});

test('remaining Xeelee books offer complete bidirectional Chinese editions', async ({ page }) => {
  await serveBuiltSite(page);

  const editions = [
    {
      englishBook: 'vacuum-diagrams',
      chineseBook: 'vacuum-diagrams-zh',
      count: 34,
      firstEnglish: 'vacuum-diagrams-xeelee-sequence-book-5',
      firstChinese: 'vacuum-diagrams-xeelee-sequence-book-5-zh',
      firstTitle: 'Xeelee 系列 第5册',
      lastEnglish: 'vacuum-diagrams-footnotes',
      lastChinese: 'vacuum-diagrams-footnotes-zh',
      lastTitle: '脚注',
    },
    {
      englishBook: 'mayflower-ii',
      chineseBook: 'mayflower-ii-zh',
      count: 11,
      firstEnglish: 'mayflower-ii-mayflower-ii',
      firstChinese: 'mayflower-ii-mayflower-ii-zh',
      firstTitle: '五月花二号',
      lastEnglish: 'mayflower-ii-x',
      lastChinese: 'mayflower-ii-x-zh',
      lastTitle: 'X',
    },
    {
      englishBook: 'xeelee-endurance',
      chineseBook: 'xeelee-endurance-zh',
      count: 50,
      firstEnglish: 'xeelee-endurance-prologue',
      firstChinese: 'xeelee-endurance-prologue-zh',
      firstTitle: '序章',
      lastEnglish: 'xeelee-endurance-the-xeelee-sequence-timeline',
      lastChinese: 'xeelee-endurance-the-xeelee-sequence-timeline-zh',
      lastTitle: 'Xeelee 系列年表',
    },
    {
      englishBook: 'xeelee-vengeance',
      chineseBook: 'xeelee-vengeance-zh',
      count: 77,
      firstEnglish: 'xeelee-vengeance-one',
      firstChinese: 'xeelee-vengeance-one-zh',
      firstTitle: '第一部',
      lastEnglish: 'xeelee-vengeance-afterword',
      lastChinese: 'xeelee-vengeance-afterword-zh',
      lastTitle: '后记',
    },
    {
      englishBook: 'xeelee-redemption',
      chineseBook: 'xeelee-redemption-zh',
      count: 89,
      firstEnglish: 'xeelee-redemption-dedication',
      firstChinese: 'xeelee-redemption-dedication-zh',
      firstTitle: '献词',
      lastEnglish: 'xeelee-redemption-afterword',
      lastChinese: 'xeelee-redemption-afterword-zh',
      lastTitle: '后记',
    },
  ];

  for (const edition of editions) {
    await page.goto(`${baseUrl}/books/${edition.englishBook}/${edition.firstEnglish}/`);
    await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
      'href',
      `/books/${edition.chineseBook}/${edition.firstChinese}/`,
    );

    await page.goto(`${baseUrl}/books/${edition.chineseBook}/`);
    await expect(page.locator('.book-toc a')).toHaveCount(edition.count);

    await page.goto(`${baseUrl}/books/${edition.chineseBook}/${edition.firstChinese}/`);
    await expect(page.locator('.article-header h1')).toHaveText(edition.firstTitle);
    await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
      'href',
      `/books/${edition.englishBook}/${edition.firstEnglish}/`,
    );

    await page.goto(`${baseUrl}/books/${edition.englishBook}/${edition.lastEnglish}/`);
    await expect(page.getByRole('link', { name: '阅读中文试译' })).toHaveAttribute(
      'href',
      `/books/${edition.chineseBook}/${edition.lastChinese}/`,
    );

    await page.goto(`${baseUrl}/books/${edition.chineseBook}/${edition.lastChinese}/`);
    await expect(page.locator('.article-header h1')).toHaveText(edition.lastTitle);
    await expect(page.getByRole('link', { name: '阅读英文原文' })).toHaveAttribute(
      'href',
      `/books/${edition.englishBook}/${edition.lastEnglish}/`,
    );
  }
});

test('Three-Body trilogy shelves as one series with volume-grouped chapter TOCs', async ({
  page,
}) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  const series = page.locator('[data-book-group]', { hasText: '三体三部曲' });
  await expect(series).toHaveCount(1);
  await expect(series.locator('.book-edition-list li')).toHaveCount(3);
  const editions = [
    ['三体', '/books/three-body/'],
    ['三体Ⅱ·黑暗森林', '/books/three-body-dark-forest/'],
    ['三体Ⅲ·死神永生', '/books/three-body-deaths-end/'],
  ];
  for (const [title, href] of editions) {
    await expect(series.locator(`a[href="${href}"]`)).toHaveAttribute('aria-label', title);
    await expect(series.locator(`a[href="${href}"] span`)).toHaveText(title);
  }
  await expect(series.locator('.book-group-count')).toHaveText('3 部');

  await page.goto(`${baseUrl}/books/three-body-dark-forest/`);
  await expect(page.locator('.book-toc-volume')).toHaveCount(4);
  await expect(page.locator('.book-toc-volume').nth(1).locator('h3')).toHaveText('上部 面壁者');

  await page.goto(`${baseUrl}/books/three-body-deaths-end/`);
  await expect(page.locator('.book-toc-volume')).toHaveCount(8);
  await expect(page.locator('.book-toc-volume').first().locator('h3')).toHaveText('纪年对照表');

  await page.goto(`${baseUrl}/books/three-body/section-001/`);
  await expect(page.locator('.article-header h1')).toHaveText('疯狂年代');
  await expect(page.locator('.prose')).toContainText('中国，1967年');
});

test('Mao selected works provides five grouped volumes and pinned source text', async ({
  page,
}) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/`);

  await expect(page.getByRole('link', { name: '毛泽东选集', exact: true })).toHaveCount(1);
  await page.goto(`${baseUrl}/books/mao-selected-works/`);
  await expect(page.locator('.book-toc-volume')).toHaveCount(5);
  await expect(page.locator('.book-toc-volume').first().locator('h3')).toHaveText(
    '第一卷 国内革命战争时期',
  );
  await expect(page.locator('.book-rights a')).toHaveAttribute(
    'href',
    /\/tree\/f23ff5c48d976561f888c6ce8c594725d5670e38$/,
  );

  await page.goto(`${baseUrl}/books/mao-selected-works/volume-01-article-001/`);
  await expect(page.locator('.article-header h1')).toHaveText('中国社会各阶级的分析');
  await expect(page.locator('.prose h1')).toHaveCount(0);
  await expect(page.locator('.prose')).toContainText('谁是我们的敌人？谁是我们的朋友？');

  const firstReference = page.locator('#user-content-fnref-1');
  const firstNote = page.locator('#user-content-fn-1');
  const preview = page.locator('[data-footnote-preview-panel]');
  await expect(firstReference).toHaveText('1');
  await expect(firstReference).toHaveAttribute('href', '#user-content-fn-1');
  await expect(firstNote).toContainText('国家主义派指中国青年党');
  await expect(page.locator('.prose')).not.toContainText('国家主义派⑴');

  await firstReference.hover();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('国家主义派指中国青年党');

  await page.goto(`${baseUrl}/books/mao-selected-works/volume-02-article-017/`);
  const titleReference = page.locator('.article-header h1 #title-fnref-1');
  await expect(page.locator('.article-header h1')).toHaveText(
    '关于国际新形势对新华日报1记者的谈话',
  );
  await expect(titleReference).toHaveAttribute('href', '#user-content-fn-1');
  await expect(page.locator('[data-title-footnote-placeholder]')).toBeHidden();
  await expect(page.locator('#user-content-fn-1 [data-footnote-backref]')).toHaveAttribute(
    'href',
    '#title-fnref-1',
  );
  await titleReference.hover();
  await expect(preview).toContainText('《新华日报》是中国共产党在国民党统治区公开出版的机关报');

  await page.goto(`${baseUrl}/books/mao-selected-works/volume-05-article-006/`);
  await expect(page.locator('#user-content-fnref-1')).toHaveAttribute('href', '#user-content-fn-1');
  await expect(page.locator('#user-content-fn-3')).toContainText('土地改革运动');
});

test('Capital footnotes jump to the note and back to the reference', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);

  const referenceId = 'zh-v1-01-_ftnref1';
  const footnoteId = 'zh-v1-01-_ftn1';
  const reference = page.locator(`#${referenceId}`);
  const footnote = page.locator(`#${footnoteId}`);

  await expect(reference).toHaveCount(1);
  await expect(footnote).toHaveCount(1);

  await reference.click();
  await expect(page).toHaveURL(`${baseUrl}/books/capital-zh/volume-01-chapter-01/#${footnoteId}`);
  await expect(footnote).toBeInViewport();

  await footnote.click();
  await expect(page).toHaveURL(`${baseUrl}/books/capital-zh/volume-01-chapter-01/#${referenceId}`);
  await expect(reference).toBeInViewport();

  await page.goto(`${baseUrl}/books/capital-de/volume-01-chapter-02-de/`);
  const germanReference = page.locator('#de-v1-me23_099-Z44');
  const germanFootnote = page.locator('#de-v1-me23_099-M44');

  await germanReference.click();
  await expect(page).toHaveURL(
    `${baseUrl}/books/capital-de/volume-01-chapter-02-de/#de-v1-me23_099-M44`,
  );
  await expect(germanFootnote).toBeInViewport();

  await germanFootnote.click();
  await expect(page).toHaveURL(
    `${baseUrl}/books/capital-de/volume-01-chapter-02-de/#de-v1-me23_099-Z44`,
  );
  await expect(germanReference).toBeInViewport();
});

test('Capital footnotes show their content on hover without navigating', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);

  const reference = page.locator('#zh-v1-01-_ftnref1');
  const preview = page.locator('[data-footnote-preview-panel]');

  await reference.hover();

  await expect(preview).toBeVisible();
  await expect(preview).toContainText('卡尔·马克思《政治经济学批判》1859年柏林版第3页');
  await expect(preview).toContainText('【26】');
  await expect(preview.locator('a[href="#zh-v1-01-_ftn1026"]')).toHaveCount(0);
  await expect(page).toHaveURL(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);

  const referenceBox = await reference.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(referenceBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(referenceBox!.y);

  await preview.hover();
  await page.waitForTimeout(180);
  await expect(preview).toBeVisible();

  await page.locator('.article-header h1').hover();
  await expect(preview).toBeHidden();

  await reference.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await reference.hover();
  const belowReferenceBox = await reference.boundingBox();
  const belowPreviewBox = await preview.boundingBox();
  expect(belowReferenceBox).not.toBeNull();
  expect(belowPreviewBox).not.toBeNull();
  expect(belowPreviewBox!.y).toBeGreaterThanOrEqual(
    belowReferenceBox!.y + belowReferenceBox!.height,
  );

  await page.locator('.article-header h1').click();
  await expect(preview).toBeHidden();

  await reference.focus();
  await expect(preview).toBeVisible();
  await page.locator('a[href="/books/"]').first().focus();
  await expect(preview).toBeHidden();
});

test('German footnote previews isolate adjacent notes', async ({ page }) => {
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/capital-de/volume-01-chapter-08-de/`);

  const preview = page.locator('[data-footnote-preview-panel]');
  const note107 = page.locator('#de-v1-me23_245-Z107');
  const note108 = page.locator('#de-v1-me23_245-Z108');

  await note107.hover();
  await expect(preview).toContainText('John Ward');
  await expect(preview).not.toContainText('Ferrands Rede');

  await note108.hover();
  await expect(preview).toContainText('Ferrands Rede');
  await expect(preview).not.toContainText('John Ward');
  await expect(page.locator('#de-v1-me23_245-M107')).not.toHaveAttribute(
    'data-footnote-preview-ref',
    '',
  );

  await page.goto(`${baseUrl}/books/capital-de/volume-03-preface-de/`);
  await page.locator('#de-v3-me25_007-FNankered1').hover();
  await expect(preview).toContainText('Peter Fireman');
  await expect(preview).not.toContainText('Stuttgart : Dietz, 1889');

  await page.goto(`${baseUrl}/books/capital-de/volume-01-chapter-13-de/`);
  await page.locator('#de-v1-me23_483-Z296').hover();
  await expect(preview).toContainText('25 Kubikzoll Luft');
});

test('standard Markdown footnotes preview complete rich content', async ({ page }) => {
  const renderer = await createMarkdownProcessor({
    rehypePlugins: [rehypeLegacyFootnoteAnchors],
  });
  const rendered = await renderer.render(`Reference[^complete]. Text only[^text-only].

[^complete]: First *rich* paragraph with an [external link](https://example.com/docs-M1_ftn).

    Second paragraph.

    ${'Long footnote content. '.repeat(180)}

[^text-only]: ${'Keyboard scroll content. '.repeat(180)}`);

  await serveBuiltSite(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${baseUrl}/about/`);
  await page.locator('.about-content').evaluate((container, html) => {
    container.insertAdjacentHTML('beforeend', html);
  }, rendered.code);

  const reference = page.locator('#user-content-fnref-complete');
  await reference.focus();
  const preview = page.locator('[data-footnote-preview-panel]');

  await expect(preview).toBeVisible();
  await expect(preview.locator('p')).toHaveCount(3);
  await expect(preview.locator('em')).toHaveText('rich');
  await expect(preview.getByRole('link', { name: 'external link' })).toHaveAttribute(
    'href',
    'https://example.com/docs-M1_ftn',
  );
  await expect(preview).toContainText('Second paragraph.');
  await expect(preview.locator('[data-footnote-backref]')).toHaveCount(0);
  await expect(preview.locator('[id]')).toHaveCount(0);

  const dimensions = await preview.evaluate((element) => ({
    box: element.getBoundingClientRect().toJSON(),
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.box.left).toBeGreaterThanOrEqual(12);
  expect(dimensions.box.right).toBeLessThanOrEqual(348);
  expect(dimensions.box.top).toBeGreaterThanOrEqual(12);
  expect(dimensions.box.bottom).toBeLessThanOrEqual(628);

  const externalLink = preview.getByRole('link', { name: 'external link' });
  await page.keyboard.press('Tab');
  await expect(externalLink).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(reference).toBeFocused();

  const lightBackground = await preview.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect
    .poll(() => preview.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(lightBackground);

  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(reference).toBeFocused();

  const textOnlyReference = page.locator('#user-content-fnref-text-only');
  await textOnlyReference.focus();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(preview).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Shift+Tab');
  await expect(textOnlyReference).toBeFocused();
});

test('touching a footnote previews first and navigates on the second tap', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await serveBuiltSite(page);
  await page.goto(`${baseUrl}/books/capital-zh/volume-01-chapter-01/`);

  const reference = page.locator('#zh-v1-01-_ftnref1');
  const preview = page.locator('[data-footnote-preview-panel]');
  const initialUrl = page.url();

  await reference.click();
  await expect(page).toHaveURL(`${baseUrl}/books/capital-zh/volume-01-chapter-01/#zh-v1-01-_ftn1`);

  await page.goto(initialUrl);
  await reference.tap();
  await expect(preview).toBeVisible();
  await expect(page).toHaveURL(initialUrl);

  await page.locator('.article-header h1').tap();
  await expect(preview).toBeHidden();

  const secondReference = page.locator('#zh-v1-01-_ftnref2');
  await secondReference.tap();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('这是精神的食欲，就象肉体的饥饿那样自然');
  await expect(page).toHaveURL(initialUrl);

  await secondReference.tap();
  await expect(page).toHaveURL(`${baseUrl}/books/capital-zh/volume-01-chapter-01/#zh-v1-01-_ftn2`);
  await expect(page.locator('#zh-v1-01-_ftn2')).toBeInViewport();
  await context.close();
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

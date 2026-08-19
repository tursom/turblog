import { resolve, sep } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

const baseUrl = 'http://turblog.test';
const distDirectory = resolve('dist');
const minimumContrast = 4.5;
const articlePath = '/posts/go-single-port-multi-protocol/';

async function serveBuiltSite(page: Page) {
  await page.route(`${baseUrl}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const filePath = resolve(distDirectory, `.${relativePath}`);

    if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) {
      await route.fulfill({ status: 404 });
      return;
    }

    try {
      await route.fulfill({ path: filePath });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test(`code tokens remain readable in the ${colorScheme} theme`, async ({ page }) => {
      await serveBuiltSite(page);
      await page.goto(`${baseUrl}${articlePath}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);

      const samples = await page.locator('.prose pre.astro-code').evaluateAll((blocks) => {
        const parseColor = (value: string) =>
          value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (color: number[]) =>
          color
            .map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            })
            .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
        const contrast = (foreground: number[], background: number[]) => {
          const values = [luminance(foreground), luminance(background)].sort(
            (left, right) => right - left,
          );
          return (values[0] + 0.05) / (values[1] + 0.05);
        };

        return blocks.flatMap((block, blockIndex) => {
          const background = parseColor(getComputedStyle(block).backgroundColor);
          const coloredElements = [block, ...block.querySelectorAll('code span[style]')];

          return coloredElements
            .filter((element) => element.textContent!.trim())
            .map((element) => ({
              block: blockIndex + 1,
              text: element.textContent!.trim().slice(0, 40),
              ratio: contrast(parseColor(getComputedStyle(element).color), background),
            }));
        });
      });

      const worstSample = samples.reduce((worst, sample) =>
        sample.ratio < worst.ratio ? sample : worst,
      );

      expect(
        worstSample.ratio,
        `Code block ${worstSample.block} token "${worstSample.text}" has insufficient contrast`,
      ).toBeGreaterThanOrEqual(minimumContrast);
    });
  });
}

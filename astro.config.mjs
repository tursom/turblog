import { fileURLToPath } from 'node:url';
import { buildContentCatalog } from './scripts/build-content-catalog.mjs';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeMermaid from 'rehype-mermaid';
import rehypeLegacyFootnoteAnchors from './src/lib/rehype-legacy-footnote-anchors.mjs';

const siteUrl = process.env.PUBLIC_SITE_URL || 'http://localhost:4321';
/** @type {string | undefined} */
let catalogCacheDir;

export default defineConfig({
  site: siteUrl,
  experimental: {
    incrementalBuild: true,
  },
  devToolbar: {
    enabled: false,
  },
  integrations: [
    {
      name: 'owner-bookshelf',
      hooks: {
        'astro:config:setup': ({ injectRoute }) => {
          injectRoute({
            pattern: '/_owner/[...page]',
            entrypoint: './src/pages/_owner/[...page].astro',
            prerender: true,
          });
          injectRoute({
            pattern: '/books/_owner/',
            entrypoint: './src/pages/books/_owner/index.astro',
            prerender: true,
          });
        },
      },
    },
    sitemap({ filter: (page) => !/\/(?:book|post)-access-manifest\.json$/.test(page) }),
    {
      name: 'content-catalog-privacy',
      hooks: {
        'astro:config:done': ({ config }) => {
          catalogCacheDir = fileURLToPath(config.cacheDir);
        },
        'astro:build:done': async ({ dir, logger }) => {
          const metrics = await buildContentCatalog(fileURLToPath(dir), {
            cacheDir: process.env.TURBLOG_CATALOG_CACHE === '0' ? undefined : catalogCacheDir,
          });
          for (const warning of metrics.cacheWarnings) logger.warn(warning);
          logger.info(
            `reference cache: parsed=${metrics.parsedPages} reused=${metrics.reusedPages} pages=${metrics.htmlFiles}; ` +
              Object.entries(metrics.timings)
                .map(([phase, ms]) => `${phase}=${Math.round(ms)}ms`)
                .join(' '),
          );
        },
      },
    },
  ],
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['mermaid'],
    },
    shikiConfig: {
      themes: {
        light: 'github-light-default',
        dark: 'github-dark-default',
      },
      defaultColor: false,
      wrap: true,
    },
    processor: unified({
      rehypePlugins: [
        rehypeLegacyFootnoteAnchors,
        [
          rehypeMermaid,
          {
            strategy: 'img-svg',
            dark: true,
            colorScheme: 'light',
          },
        ],
      ],
    }),
  },
});

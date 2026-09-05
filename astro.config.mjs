import { fileURLToPath } from 'node:url';
import { buildContentCatalog } from './scripts/build-content-catalog.mjs';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeMermaid from 'rehype-mermaid';
import rehypeLegacyFootnoteAnchors from './src/lib/rehype-legacy-footnote-anchors.mjs';

const siteUrl = process.env.PUBLIC_SITE_URL || 'http://localhost:4321';

export default defineConfig({
  site: siteUrl,
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
        'astro:build:done': async ({ dir }) => {
          await buildContentCatalog(fileURLToPath(dir));
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

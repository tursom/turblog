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
    sitemap({ filter: (page) => !page.endsWith('/book-access-manifest.json') }),
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

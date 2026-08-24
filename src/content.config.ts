import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      summary: z.string().min(1),
      publishedAt: z.coerce.date(),
      updatedAt: z.coerce.date().optional(),
      tags: z.array(z.string().min(1)).min(1),
      aiAssisted: z.boolean().default(false),
      cover: image().nullable().optional(),
    }),
});

const books = defineCollection({
  loader: glob({ pattern: '*/book.md', base: './src/content/books' }),
  schema: z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string(),
    subtitle: z.string().optional(),
    author: z.string(),
    translator: z.string().optional(),
    language: z.string().default('zh-CN'),
    publishedAt: z.coerce.date().nullable().optional(),
    summary: z.string().min(1),
    sourceUrl: z.string().regex(/^https?:\/\//),
    rightsNotice: z.string().min(1),
    cover: z.string().nullable().optional(),
    chapterCount: z.number().int().positive(),
  }),
});

const bookChapters = defineCollection({
  loader: glob({ pattern: '*/chapters/*.md', base: './src/content/books' }),
  schema: z.object({
    bookSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chapterNumber: z.number().int().positive(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string(),
    sourcePath: z.string().min(1),
  }),
});

export const collections = { posts, books, bookChapters };

import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseFrontmatter } from '@astrojs/markdown-remark';

if (existsSync('.env')) process.loadEnvFile('.env');

const input = process.argv[2];
if (!input) {
  console.error('Usage: pnpm book:share /books/<book-slug>/<chapter-slug>/');
  process.exit(1);
}

let chapterPath;
try {
  chapterPath = new URL(input, 'https://turblog.local').pathname;
} catch {
  console.error(`Invalid chapter path: ${input}`);
  process.exit(1);
}

if (!/^\/books\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(chapterPath)) {
  console.error('Chapter path must match /books/<book-slug>/<chapter-slug>/ and end with a slash.');
  process.exit(1);
}

const bookSlug = chapterPath.split('/')[2];
let metadata;
try {
  const source = await readFile(resolve('src/content/books', bookSlug, 'book.md'), 'utf8');
  metadata = parseFrontmatter(source).frontmatter;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to read metadata for ${bookSlug}: ${message}`);
  process.exit(1);
}
if (metadata.slug !== bookSlug || metadata.private !== true) {
  console.error(`Book is not marked private in its metadata: ${bookSlug}`);
  process.exit(1);
}

const password = process.env.TURBLOG_BOOK_ACCESS_PASSWORD ?? '';
if (Buffer.byteLength(password, 'utf8') < 32) {
  console.error('TURBLOG_BOOK_ACCESS_PASSWORD must contain at least 32 bytes.');
  process.exit(1);
}

const siteURL = (process.env.PUBLIC_SITE_URL || 'http://localhost:4321').replace(/\/+$/, '');
const token = createHmac('sha256', password).update(chapterPath).digest('base64url');
console.log(`${siteURL}${chapterPath}#access=${token}`);

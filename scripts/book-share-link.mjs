import { createHmac, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseFrontmatter } from '@astrojs/markdown-remark';

if (existsSync('.env')) process.loadEnvFile('.env');

const input = process.argv[2];
if (!input) {
  console.error('Usage: pnpm book:share /books/<book-slug>/[<chapter-slug>/]');
  process.exit(1);
}

let contentPath;
try {
  contentPath = new URL(input, 'https://turblog.local').pathname;
} catch {
  console.error(`Invalid book content path: ${input}`);
  process.exit(1);
}

if (!/^\/books\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?$/.test(contentPath)) {
  console.error(
    'Book content path must match /books/<book-slug>/ or /books/<book-slug>/<chapter-slug>/ and end with a slash.',
  );
  process.exit(1);
}

const bookSlug = contentPath.split('/')[2];
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
if (Array.from(password).length < 8) {
  console.error('TURBLOG_BOOK_ACCESS_PASSWORD must contain at least 8 characters.');
  process.exit(1);
}

const key = pbkdf2Sync(password, 'turblog-book-access-v2', 600_000, 32, 'sha256');
const token = createHmac('sha256', key).update(contentPath).digest('base64url');
const siteURL = (process.env.PUBLIC_SITE_URL || 'http://localhost:4321').replace(/\/+$/, '');
console.log(`${siteURL}${contentPath}#access=${token}`);

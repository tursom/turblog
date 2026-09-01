import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import process from 'node:process';

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

const password = process.env.TURBLOG_BOOK_ACCESS_PASSWORD ?? '';
if (Buffer.byteLength(password, 'utf8') < 32) {
  console.error('TURBLOG_BOOK_ACCESS_PASSWORD must contain at least 32 bytes.');
  process.exit(1);
}

const siteURL = (process.env.PUBLIC_SITE_URL || 'http://localhost:4321').replace(/\/+$/, '');
const token = createHmac('sha256', password).update(chapterPath).digest('base64url');
console.log(`${siteURL}${chapterPath}#access=${token}`);

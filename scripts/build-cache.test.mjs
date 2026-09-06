import assert from 'node:assert/strict';
import test from 'node:test';
import { bookCacheKey, pageCacheKey } from '../src/lib/build-cache.mjs';

const book = { data: { slug: 'example', title: 'Example', private: false } };
const chapters = [
  { data: { slug: 'first', title: 'First', chapterNumber: 1 }, body: 'First body' },
  { data: { slug: 'second', title: 'Second', chapterNumber: 2 }, body: 'Second body' },
];

test('page keys are deterministic and track body and visibility changes', () => {
  const post = { title: 'Post', private: false, publishedAt: new Date('2026-01-01') };
  const key = pageCacheKey(post, 'body');
  assert.equal(key, pageCacheKey(structuredClone(post), 'body'));
  assert.notEqual(key, pageCacheKey(post, 'edited body'));
  assert.notEqual(key, pageCacheKey({ ...post, private: true }, 'body'));
});

test('book keys track ordered metadata but not sibling chapter bodies', () => {
  const key = bookCacheKey(book, chapters);
  const bodyEdit = structuredClone(chapters);
  bodyEdit[1].body = 'Edited second body';
  assert.equal(key, bookCacheKey(book, bodyEdit));
  const titleEdit = structuredClone(chapters);
  titleEdit[1].data.title = 'Renamed';
  assert.notEqual(key, bookCacheKey(book, titleEdit));
  assert.notEqual(key, bookCacheKey(book, chapters.toReversed()));
  assert.notEqual(key, bookCacheKey(book, chapters.slice(0, 1)));
  assert.notEqual(key, bookCacheKey({ data: { ...book.data, private: true } }, chapters));
});

test('page keys track the layout year', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-01') });
  const key = pageCacheKey('same content');
  t.mock.timers.setTime(new Date('2027-06-01').valueOf());
  assert.notEqual(key, pageCacheKey('same content'));
});

test('page keys track the public API base path', (t) => {
  const original = process.env.PUBLIC_API_BASE_PATH;
  t.after(() => {
    if (original === undefined) delete process.env.PUBLIC_API_BASE_PATH;
    else process.env.PUBLIC_API_BASE_PATH = original;
  });
  process.env.PUBLIC_API_BASE_PATH = '/api/v1';
  const key = pageCacheKey('same content');
  process.env.PUBLIC_API_BASE_PATH = '/api/v2';
  assert.notEqual(key, pageCacheKey('same content'));
});

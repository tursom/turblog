import { createHash } from 'node:crypto';

/** @param {unknown[]} inputs */
export function pageCacheKey(...inputs) {
  // These layout inputs can change without changing a page's source or content.
  return createHash('sha256')
    .update(
      JSON.stringify({
        year: new Date().getFullYear(),
        apiBasePath:
          import.meta.env?.PUBLIC_API_BASE_PATH ?? process.env.PUBLIC_API_BASE_PATH ?? '/api/v1',
        inputs,
      }),
    )
    .digest('hex');
}

/**
 * The ordered metadata covers the TOC and both reader-navigation links, without
 * invalidating sibling pages when only a chapter's body changes.
 * @param {{ data: unknown }} book
 * @param {{ data: unknown }[]} chapters
 */
export function bookCacheKey(book, chapters) {
  return pageCacheKey(
    book.data,
    chapters.map((chapter) => chapter.data),
  );
}

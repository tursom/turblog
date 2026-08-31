import { getCollection, type CollectionEntry } from 'astro:content';

export type Book = CollectionEntry<'books'>;
export type BookChapter = CollectionEntry<'bookChapters'>;

export async function getBooks(): Promise<Book[]> {
  const books = await getCollection('books');
  return books.sort((a, b) => a.data.title.localeCompare(b.data.title, 'zh-CN'));
}

export async function getBookChapters(bookSlug: string): Promise<BookChapter[]> {
  const chapters = await getCollection('bookChapters', ({ data }) => data.bookSlug === bookSlug);
  return chapters.sort((a, b) => a.data.chapterNumber - b.data.chapterNumber);
}

export function bookPath(book: Pick<Book, 'data'>): string {
  return `/books/${book.data.slug}/`;
}

export function chapterPath(book: Pick<Book, 'data'>, chapter: Pick<BookChapter, 'data'>): string {
  return `/books/${book.data.slug}/${chapter.data.slug}/`;
}

export function alternateBookPath(book: Pick<Book, 'data'>): string | null {
  return book.data.alternateEditionSlug ? `/books/${book.data.alternateEditionSlug}/` : null;
}

export function parallelChapterPath(
  book: Pick<Book, 'data'>,
  chapter: Pick<BookChapter, 'data'>,
): string | null {
  if (!book.data.alternateEditionSlug || !chapter.data.parallelSlug) return null;
  return `/books/${book.data.alternateEditionSlug}/${chapter.data.parallelSlug}/`;
}

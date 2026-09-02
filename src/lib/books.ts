import { getCollection, type CollectionEntry } from 'astro:content';

export type Book = CollectionEntry<'books'>;
export type BookChapter = CollectionEntry<'bookChapters'>;
export type BookCategory = Book['data']['category'];

export interface BookGroup {
  slug: string;
  title: string;
  category: BookCategory;
  type: Book['data']['groupType'];
  order: number;
  books: Book[];
  chapterCount: number;
}

export const bookCategoryLabels: Record<BookCategory, string> = {
  works: '著作',
  textbook: '教材',
};

export async function getBooks(): Promise<Book[]> {
  const books = await getCollection('books');
  return books.sort(
    (a, b) =>
      a.data.groupOrder - b.data.groupOrder ||
      a.data.seriesOrder - b.data.seriesOrder ||
      a.data.title.localeCompare(b.data.title, 'zh-CN'),
  );
}

export async function getBookGroups(): Promise<BookGroup[]> {
  const groups = new Map<string, BookGroup>();

  for (const book of await getBooks()) {
    const existing = groups.get(book.data.groupSlug);
    if (existing) {
      if (
        existing.title !== book.data.groupTitle ||
        existing.category !== book.data.category ||
        existing.type !== book.data.groupType ||
        existing.order !== book.data.groupOrder
      ) {
        throw new Error(`图书分组 ${book.data.groupSlug} 的元数据不一致`);
      }
      existing.books.push(book);
      existing.chapterCount += book.data.chapterCount;
      continue;
    }

    groups.set(book.data.groupSlug, {
      slug: book.data.groupSlug,
      title: book.data.groupTitle,
      category: book.data.category,
      type: book.data.groupType,
      order: book.data.groupOrder,
      books: [book],
      chapterCount: book.data.chapterCount,
    });
  }

  return [...groups.values()].sort((a, b) => a.order - b.order);
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

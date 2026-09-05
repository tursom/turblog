import { getCollection, type CollectionEntry } from 'astro:content';

export const PAGE_SIZE = 10;
export type Post = CollectionEntry<'posts'>;

export async function getPosts(includePrivate = false): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => includePrivate || !data.private);
  return posts.sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());
}

export function postPath(post: Pick<Post, 'data'>): string {
  return `/posts/${post.data.slug}/`;
}

export function tagSlug(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function tagPath(tag: string): string {
  return `/tags/${encodeURIComponent(tagSlug(tag))}/`;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatDateLabel(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function readingMinutes(body: string): number {
  const chineseCharacters = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (body.match(/[A-Za-z0-9]+/g) ?? []).length;
  return Math.max(1, Math.ceil((chineseCharacters + latinWords * 2) / 420));
}

export function paginate<T>(items: T[], page: number, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  return {
    items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    currentPage,
    totalPages,
  };
}

export type PostPage = ReturnType<typeof paginate<Post>>;

export function allTags(posts: Post[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

import { getCollection } from 'astro:content';

export const prerender = true;

export async function GET() {
  const books = await getCollection('books');
  const privateBooks = books
    .filter((book) => book.data.private)
    .map((book) => book.data.slug)
    .sort();

  return new Response(`${JSON.stringify({ version: 1, privateBooks }, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

import { getCollection } from 'astro:content';

export const prerender = true;

export async function GET() {
  const posts = await getCollection('posts');
  const privatePosts = posts
    .filter((post) => post.data.private)
    .map((post) => post.data.slug)
    .sort();

  return new Response(
    `${JSON.stringify({ version: 1, privatePosts, privateAssets: {} }, null, 2)}\n`,
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

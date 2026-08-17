import rss from '@astrojs/rss';
import { getPosts, postPath } from '@/lib/posts';

export async function GET(context: { site?: URL; url: URL }) {
  const posts = await getPosts();
  const site = context.site ?? context.url;
  return rss({
    title: 'Tursom Log',
    description: '关于软件、系统与长期实践的技术记录。',
    site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.summary,
      pubDate: post.data.publishedAt,
      link: postPath(post),
    })),
    customData: '<language>zh-CN</language>',
  });
}

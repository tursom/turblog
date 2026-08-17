export function GET({ site }: { site?: URL }) {
  const sitemap = new URL('/sitemap-index.xml', site ?? 'http://localhost:4321').href;
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

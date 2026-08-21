package catalog_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tursom/turblog/server/internal/catalog"
)

func TestLoadExtractsOnlyCanonicalArticleSlugs(t *testing.T) {
	t.Parallel()

	sitemapPath := filepath.Join(t.TempDir(), "sitemap.xml")
	sitemap := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://blog.tursom.dev/</loc></url>
  <url><loc>https://blog.tursom.dev/posts/go-atomic-generics/</loc></url>
  <url><loc>https://blog.tursom.dev/posts/row-linked-list/</loc></url>
  <url><loc>https://blog.tursom.dev/posts/nested/not-an-article/</loc></url>
  <url><loc>https://blog.tursom.dev/tags/go/</loc></url>
</urlset>`
	if err := os.WriteFile(sitemapPath, []byte(sitemap), 0o600); err != nil {
		t.Fatal(err)
	}

	articles, err := catalog.Load(sitemapPath)
	if err != nil {
		t.Fatal(err)
	}
	if !articles.Contains("go-atomic-generics") || !articles.Contains("row-linked-list") {
		t.Fatalf("catalog does not contain expected article slugs: %#v", articles.Slugs())
	}
	if articles.Contains("nested/not-an-article") {
		t.Fatal("catalog accepted a nested non-canonical article path")
	}
	if got := articles.Slugs(); len(got) != 2 || got[0] != "go-atomic-generics" || got[1] != "row-linked-list" {
		t.Fatalf("Slugs() = %#v", got)
	}
}

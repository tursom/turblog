package catalog_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tursom/turblog/server/internal/catalog"
)

func TestLoadBookAccessManifest(t *testing.T) {
	t.Parallel()

	manifestPath := filepath.Join(t.TempDir(), "book-access-manifest.json")
	if err := os.WriteFile(manifestPath, []byte(`{"version":1,"privateBooks":["private-book","another-book"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	privateBooks, err := catalog.LoadBookAccessManifest(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(privateBooks) != 2 || privateBooks[0] != "another-book" || privateBooks[1] != "private-book" {
		t.Fatalf("private books = %#v", privateBooks)
	}

	invalidManifests := []string{
		`{"version":2,"privateBooks":[]}`,
		`{"version":1}`,
		`{"version":1,"privateBooks":["INVALID"]}`,
		`{"version":1,"privateBooks":["same-book","same-book"]}`,
		`{"version":1,"privateBooks":[],"unexpected":true}`,
		`{"version":1,"privateBooks":[]} {}`,
	}
	for _, contents := range invalidManifests {
		if err := os.WriteFile(manifestPath, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := catalog.LoadBookAccessManifest(manifestPath); err == nil {
			t.Fatalf("LoadBookAccessManifest() accepted %s", contents)
		}
	}
}

func TestLoadExtractsOnlyCanonicalArticleSlugs(t *testing.T) {
	t.Parallel()

	sitemapPath := filepath.Join(t.TempDir(), "sitemap.xml")
	sitemap := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://blog.tursom.dev/</loc></url>
  <url><loc>https://blog.tursom.dev/posts/go-atomic-generics/</loc></url>
  <url><loc>https://blog.tursom.dev/posts/row-linked-list/</loc></url>
  <url><loc>https://blog.tursom.dev/books/guns-germs-steel/chapter-01/</loc></url>
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
	if !articles.ContainsBook("guns-germs-steel") || articles.ContainsBook("missing-book") {
		t.Fatalf("book membership is incorrect")
	}
	if id, ok := articles.BookChapterIDFromPath("/books/guns-germs-steel/chapter-01/"); !ok || id != "guns-germs-steel/chapter-01" {
		t.Fatalf("book chapter id = %q, ok=%v", id, ok)
	}
	if _, ok := articles.BookChapterIDFromPath("/books/guns-germs-steel/chapter-02/"); ok {
		t.Fatal("catalog accepted an unknown book chapter")
	}
	if got := articles.Slugs(); len(got) != 2 || got[0] != "go-atomic-generics" || got[1] != "row-linked-list" {
		t.Fatalf("Slugs() = %#v", got)
	}
}

package config_test

import (
	"testing"

	"github.com/tursom/turblog/server/internal/config"
)

func TestLoadUsesProductionDefaultsAndRequiresHashKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"TURBLOG_VISITOR_HASH_KEY":     "0123456789abcdef0123456789abcdef",
		"TURBLOG_BOOK_ACCESS_PASSWORD": "book-pass",
	}
	loaded, err := config.Load(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ListenAddress != ":8080" {
		t.Fatalf("listen address = %q", loaded.ListenAddress)
	}
	if loaded.DatabasePath != "/var/lib/turblog/server.sqlite" {
		t.Fatalf("database path = %q", loaded.DatabasePath)
	}
	if loaded.SitemapPath != "/usr/share/nginx/html/_internal/content-catalog.xml" {
		t.Fatalf("sitemap path = %q", loaded.SitemapPath)
	}
	if loaded.BookAccessManifestPath != "/usr/share/nginx/html/book-access-manifest.json" {
		t.Fatalf("book access manifest path = %q", loaded.BookAccessManifestPath)
	}
	if loaded.PostAccessManifestPath != "/usr/share/nginx/html/post-access-manifest.json" {
		t.Fatalf("post access manifest path = %q", loaded.PostAccessManifestPath)
	}
	if loaded.ContentUpstream.String() != "http://blog:8080" {
		t.Fatalf("content upstream = %q", loaded.ContentUpstream)
	}
	if loaded.Location.String() != "Asia/Shanghai" {
		t.Fatalf("location = %q", loaded.Location)
	}
	if string(loaded.BookAccessPassword) != values["TURBLOG_BOOK_ACCESS_PASSWORD"] {
		t.Fatalf("book access password was not loaded")
	}
	if loaded.TrustProxyHeaders {
		t.Fatal("proxy headers are trusted by default")
	}

	values["TURBLOG_SITEMAP_PATH"] = "/tmp/custom-catalog.xml"
	loaded, err = config.Load(func(name string) string { return values[name] })
	if err != nil || loaded.SitemapPath != values["TURBLOG_SITEMAP_PATH"] {
		t.Fatalf("sitemap override = %q, error = %v", loaded.SitemapPath, err)
	}

	values["TURBLOG_POST_ACCESS_MANIFEST_PATH"] = "/tmp/post-manifest.json"
	loaded, err = config.Load(func(name string) string { return values[name] })
	if err != nil || loaded.PostAccessManifestPath != values["TURBLOG_POST_ACCESS_MANIFEST_PATH"] {
		t.Fatalf("post manifest override = %q, error = %v", loaded.PostAccessManifestPath, err)
	}

	values["TURBLOG_TRUST_PROXY_HEADERS"] = "true"
	loaded, err = config.Load(func(name string) string { return values[name] })
	if err != nil || !loaded.TrustProxyHeaders {
		t.Fatalf("trusted proxy config = %t, error = %v", loaded.TrustProxyHeaders, err)
	}
	values["TURBLOG_TRUST_PROXY_HEADERS"] = "invalid"
	if _, err := config.Load(func(name string) string { return values[name] }); err == nil {
		t.Fatal("Load() accepted an invalid trusted proxy setting")
	}

	if _, err := config.Load(func(string) string { return "" }); err == nil {
		t.Fatal("Load() accepted a missing hash key")
	}
	values["TURBLOG_VISITOR_HASH_KEY"] = "0123456789abcdef0123456789abcdef"
	values["TURBLOG_BOOK_ACCESS_PASSWORD"] = "short"
	if _, err := config.Load(func(name string) string { return values[name] }); err == nil {
		t.Fatal("Load() accepted a book access password shorter than eight characters")
	}
}

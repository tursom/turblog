package config_test

import (
	"testing"

	"github.com/tursom/turblog/server/internal/config"
)

func TestLoadUsesProductionDefaultsAndRequiresHashKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"TURBLOG_VISITOR_HASH_KEY":     "0123456789abcdef0123456789abcdef",
		"TURBLOG_BOOK_ACCESS_PASSWORD": "0123456789abcdef0123456789abcdef",
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
	if loaded.SitemapPath != "/usr/share/nginx/html/sitemap-0.xml" {
		t.Fatalf("sitemap path = %q", loaded.SitemapPath)
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
	values["TURBLOG_BOOK_ACCESS_PASSWORD"] = "too-short"
	if _, err := config.Load(func(name string) string { return values[name] }); err == nil {
		t.Fatal("Load() accepted a short book access password")
	}
}

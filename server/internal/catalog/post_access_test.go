package catalog_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tursom/turblog/server/internal/catalog"
)

func TestLoadPostAccessManifest(t *testing.T) {
	t.Parallel()
	filename := filepath.Join(t.TempDir(), "post-access-manifest.json")
	contents := `{"version":1,"privatePosts":["secret","another"],"privateAssets":{"/_astro/photo_hash.webp":["secret","another"],"/downloads/file.pdf":["secret"]}}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := catalog.LoadPostAccessManifest(filename)
	if err != nil {
		t.Fatal(err)
	}
	want := catalog.PostAccessManifest{
		PrivatePosts: []string{"another", "secret"},
		PrivateAssets: map[string][]string{
			"/_astro/photo_hash.webp": {"another", "secret"},
			"/downloads/file.pdf":     {"secret"},
		},
	}
	if !reflect.DeepEqual(manifest, want) {
		t.Fatalf("manifest = %#v, want %#v", manifest, want)
	}
	if err := os.WriteFile(filename, []byte(`{"version":1,"privatePosts":[],"privateAssets":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.LoadPostAccessManifest(filename); err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.LoadPostAccessManifest(filename + ".missing"); err == nil {
		t.Fatal("accepted missing manifest")
	}
}

func TestLoadPostAccessManifestRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	invalid := []string{
		`null`, `[]`, `{`,
		`{"version":2,"privatePosts":[],"privateAssets":{}}`,
		`{"version":1,"privatePosts":[]}`,
		`{"version":1,"privateAssets":{}}`,
		`{"version":1,"privatePosts":null,"privateAssets":{}}`,
		`{"version":1,"privatePosts":[],"privateAssets":null}`,
		`{"version":1,"privatePosts":[],"privateAssets":[]}`,
		`{"version":1,"privatePosts":[null],"privateAssets":{}}`,
		`{"version":1,"privatePosts":["BAD"],"privateAssets":{}}`,
		`{"version":1,"privatePosts":["a/b"],"privateAssets":{}}`,
		`{"version":1,"privatePosts":["same","same"],"privateAssets":{}}`,
		`{"version":1,"privatePosts":[],"privateAssets":{},"unknown":true}`,
		`{"Version":1,"privatePosts":[],"privateAssets":{}}`,
		`{"version":1,"privatePosts":[],"privateAssets":{}} {}`,
		`{"version":1,"privatePosts":["secret"],"privatePosts":[],"privateAssets":{}}`,
		`{"version":1,"privatePosts":["secret"],"privateAssets":{"/images/a.png":["secret"],"/images/a.png":["secret"]}}`,
		`{"version":1,"privatePosts":["secret"],"privateAssets":{"/images/a.png":[]}}`,
		`{"version":1,"privatePosts":["secret"],"privateAssets":{"/images/a.png":null}}`,
		`{"version":1,"privatePosts":["secret"],"privateAssets":{"/images/a.png":["unknown"]}}`,
		`{"version":1,"privatePosts":["secret"],"privateAssets":{"/images/a.png":["secret","secret"]}}`,
	}
	for _, asset := range []string{
		"images/a.png", "//host/a.png", "/images/../a.png", "/images//a.png",
		"/images/%61.png", "/images/a.png?raw", "/images/a.png#hash", "/images/a b.png",
		"/_internal/a.png", "/_content/a.png", "/_owner/a.png", "/posts/a.png",
		"/books/a.png", "/api/a.png", "/_astro/common.js", "/_astro/common.css",
		"/favicon.svg", "/favicon-32.png", "/images/a.html",
	} {
		invalid = append(invalid, `{"version":1,"privatePosts":["secret"],"privateAssets":{"`+asset+`":["secret"]}}`)
	}
	for _, contents := range invalid {
		t.Run(contents, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "manifest.json")
			if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := catalog.LoadPostAccessManifest(filename); err == nil {
				t.Fatalf("accepted %s", contents)
			}
		})
	}
}

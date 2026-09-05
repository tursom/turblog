package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/httpserver"
)

const privatePostPath = "/posts/go-atomic-generics/"

func postPrivacyBackend(t *testing.T) (http.Handler, *analytics.Tracker) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if strings.Contains(r.URL.Path, "missing") {
			http.Error(w, "upstream missing", http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, r.URL.Path)
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, _ := url.Parse(upstream.URL)
	tracker, content := newBackend(t, nil)
	return httpserver.New(httpserver.Config{
		Analytics: tracker, Catalog: content, ContentUpstream: upstreamURL,
		PrivateBookSlugs:   []string{"guns-germs-steel"},
		PrivatePostSlugs:   []string{"go-atomic-generics"},
		PrivatePostAssets:  map[string][]string{"/_astro/secret.webp": {"go-atomic-generics"}},
		BookAccessPassword: []byte(testBookAccessPassword),
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
	}), tracker
}

func TestPrivatePostsAndInternalAliasesAreHidden(t *testing.T) {
	t.Parallel()
	handler, _ := postPrivacyBackend(t)
	for _, path := range []string{
		privatePostPath, "/posts/go-atomic-generics", privatePostPath + "index.html",
		"/posts/not-published/", "/posts/not-published/index.html", "/_astro/secret.webp", "/_astro/missing.webp",
		"/_owner/", "/_owner/archive/index.html", "/_content/posts/go-atomic-generics/",
		"/_internal/posts/go-atomic-generics/", "/post-access-manifest.json",
	} {
		t.Run(path, func(t *testing.T) {
			response := privacyRequest(handler, http.MethodGet, path, "")
			if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "页面未找到") ||
				strings.Contains(response.Body.String(), "go-atomic-generics") || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("hidden response = %d %v %s", response.Code, response.Header(), response.Body.String())
			}
		})
	}
	owner := &http.Cookie{Name: "turblog_book_owner", Value: ownerToken}
	if response := privacyRequest(handler, http.MethodGet, "/_content/posts/go-atomic-generics/", "", owner); response.Code != http.StatusNotFound {
		t.Fatalf("owner bypass route = %d", response.Code)
	}
}

func TestOneOwnerCookieUnlocksPostsBooksAndAllIndexes(t *testing.T) {
	t.Parallel()
	handler, tracker := postPrivacyBackend(t)
	login := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", `{"path":"/","owner_token":"`+ownerToken+`"}`)
	if login.Code != http.StatusSeeOther || login.Header().Get("Location") != "/" {
		t.Fatalf("login = %d %v", login.Code, login.Header())
	}
	owner := login.Result().Cookies()[0]
	for _, tc := range []struct{ path, upstream string }{
		{"/", "/_owner/"}, {"/index.html", "/_owner/"},
		{"/archive/", "/_owner/archive/"}, {"/archive/2/index.html", "/_owner/archive/2/"},
		{"/tags/", "/_owner/tags/"}, {"/tags/法律/", "/_owner/tags/法律/"},
		{privatePostPath, "/_content" + privatePostPath},
		{privatePostPath + "index.html", "/_content" + privatePostPath},
		{"/_astro/secret.webp", "/_content/assets/_astro/secret.webp"},
		{"/books/", "/books/_owner/"},
		{privateChapterPath, privateChapterPath},
	} {
		response := privacyRequest(handler, http.MethodGet, tc.path, "", owner)
		if response.Code != http.StatusOK || response.Body.String() != tc.upstream ||
			len(response.Header().Values("Cache-Control")) != 1 ||
			response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Header().Get("X-Robots-Tag"), "noindex") {
			t.Fatalf("%s response = %d %v %s", tc.path, response.Code, response.Header(), response.Body.String())
		}
	}
	counts, err := tracker.ArticleViewCounts(context.Background(), []string{"go-atomic-generics"})
	if err != nil || counts.Values["go-atomic-generics"] != 1 {
		t.Fatalf("canonical private article counts = %v, %v", counts, err)
	}
	for _, path := range []string{"/", "/archive/", "/tags/"} {
		response := privacyRequest(handler, http.MethodGet, path, "")
		if response.Body.String() != path || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("anonymous index %s = %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestPrivatePostShareDoesNotUnlockOtherResources(t *testing.T) {
	t.Parallel()
	handler, _ := postPrivacyBackend(t)
	owner := &http.Cookie{Name: "turblog_book_owner", Value: ownerToken}
	shared := privacyRequest(handler, http.MethodPost, "/books/_access/share", `{"path":"`+privatePostPath+`"}`, owner)
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(shared.Body.Bytes(), &payload); err != nil || shared.Code != http.StatusOK || payload.Token != shareToken(privatePostPath) {
		t.Fatalf("share response = %d %s (%v)", shared.Code, shared.Body.String(), err)
	}
	grant := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", `{"path":"`+privatePostPath+`","token":"`+payload.Token+`"}`)
	if grant.Code != http.StatusNoContent {
		t.Fatalf("grant = %d %s", grant.Code, grant.Body.String())
	}
	cookies := grant.Result().Cookies()
	for _, path := range []string{privatePostPath, "/_astro/secret.webp"} {
		if response := privacyRequest(handler, http.MethodGet, path, "", cookies...); response.Code != http.StatusOK {
			t.Fatalf("shared path %s = %d", path, response.Code)
		}
	}
	for _, path := range []string{privateChapterPath, "/books/_owner/", "/_owner/"} {
		if response := privacyRequest(handler, http.MethodGet, path, "", cookies...); response.Code != http.StatusNotFound {
			t.Fatalf("share escaped to %s = %d", path, response.Code)
		}
	}
	if response := privacyRequest(handler, http.MethodGet, "/", "", cookies...); response.Body.String() != "/" {
		t.Fatalf("share exposed owner home: %s", response.Body.String())
	}
	if response := privacyRequest(handler, http.MethodPost, "/books/_access/share", `{"path":"`+privatePostPath+`"}`, cookies...); response.Code != http.StatusForbidden {
		t.Fatalf("guest sharing = %d", response.Code)
	}
	bookCookie := &http.Cookie{Name: "turblog_book_access", Value: shareToken(privateBookPath)}
	if response := privacyRequest(handler, http.MethodGet, privatePostPath, "", bookCookie); response.Code != http.StatusNotFound {
		t.Fatalf("book share unlocked post = %d", response.Code)
	}
}

func TestPrivatePostStatsDoNotRevealExistence(t *testing.T) {
	t.Parallel()
	handler, _ := postPrivacyBackend(t)
	body := `{"metric":"article_unique_views","subject_type":"article","subject_ids":["go-atomic-generics","row-linked-list","missing"]}`
	for _, authorized := range []bool{false, true} {
		var cookies []*http.Cookie
		if authorized {
			cookies = append(cookies, &http.Cookie{Name: "turblog_book_access", Value: shareToken(privatePostPath)})
		}
		response := privacyRequest(handler, http.MethodPost, "/api/v1/analytics/metrics/query", body, cookies...)
		var payload struct {
			Values  map[string]int64 `json:"values"`
			Unknown []string         `json:"unknown"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || response.Code != http.StatusOK {
			t.Fatalf("metrics = %d %s %v", response.Code, response.Body.String(), err)
		}
		if _, exists := payload.Values["go-atomic-generics"]; exists != authorized {
			t.Fatalf("private metrics authorized=%v: %#v", authorized, payload)
		}
		if _, exists := payload.Values["row-linked-list"]; !exists {
			t.Fatalf("public metric missing: %#v", payload)
		}
		expected := "go-atomic-generics,missing"
		if authorized {
			expected = "missing"
		}
		if strings.Join(payload.Unknown, ",") != expected {
			t.Fatalf("unknown=%v", payload.Unknown)
		}
	}
}

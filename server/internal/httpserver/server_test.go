package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/catalog"
	"github.com/tursom/turblog/server/internal/httpserver"
)

func TestMetricsQueryReturnsAllRequestedArticleCountsInOneResponse(t *testing.T) {
	t.Parallel()

	tracker, articles := newBackend(t, nil)
	_, err := tracker.RecordArticleView(context.Background(), analytics.ArticleView{
		Slug:       "go-atomic-generics",
		ClientIP:   "203.0.113.8",
		UserAgent:  "Example Browser",
		ClientKind: analytics.ClientBrowser,
		OccurredAt: time.Date(2026, 8, 21, 9, 0, 0, 0, time.FixedZone("CST", 8*60*60)),
	})
	if err != nil {
		t.Fatal(err)
	}

	handler := httpserver.New(httpserver.Config{
		Analytics: tracker,
		Catalog:   articles,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	body := bytes.NewBufferString(`{
		"metric":"article_unique_views",
		"subject_type":"article",
		"subject_ids":["go-atomic-generics","row-linked-list","missing"]
	}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/metrics/query", body)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Metric  string           `json:"metric"`
		Values  map[string]int64 `json:"values"`
		Unknown []string         `json:"unknown"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Metric != "article_unique_views" || payload.Values["go-atomic-generics"] != 1 || payload.Values["row-linked-list"] != 0 {
		t.Fatalf("payload = %#v", payload)
	}
	if len(payload.Unknown) != 1 || payload.Unknown[0] != "missing" {
		t.Fatalf("unknown = %#v", payload.Unknown)
	}
}

func TestArticleProxyRecordsSuccessfulHTMLGetAndPreservesResponse(t *testing.T) {
	t.Parallel()

	type upstreamRequest struct {
		host    string
		headers http.Header
	}
	received := make(chan upstreamRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		received <- upstreamRequest{host: request.Host, headers: request.Header.Clone()}
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.Header().Set("X-Upstream", "blog")
		_, _ = response.Write([]byte("<article>hello</article>"))
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracker, articles := newBackend(t, nil)
	fixedTime := time.Date(2026, 8, 21, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	handler := httpserver.New(httpserver.Config{
		Analytics:         tracker,
		Catalog:           articles,
		ContentUpstream:   upstreamURL,
		Now:               func() time.Time { return fixedTime },
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		TrustProxyHeaders: true,
	})
	request := httptest.NewRequest(http.MethodGet, "/posts/go-atomic-generics/", nil)
	request.Host = "blog.tursom.dev"
	request.Header.Set("User-Agent", "curl/8.14.1")
	request.Header.Set("CF-Connecting-IP", "203.0.113.8")
	request.Header.Set("X-Forwarded-For", "203.0.113.8")
	request.Header.Set("X-Real-IP", "203.0.113.8")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("Referer", "https://search.example/results?q=go")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "<article>hello</article>" {
		t.Fatalf("proxy response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("X-Upstream") != "blog" {
		t.Fatalf("upstream header = %q", response.Header().Get("X-Upstream"))
	}
	if response.Header().Get("Cache-Control") != "private, no-cache, must-revalidate" {
		t.Fatalf("cache control = %q", response.Header().Get("Cache-Control"))
	}
	forwarded := <-received
	if forwarded.host != "blog.tursom.dev" {
		t.Fatalf("upstream host = %q", forwarded.host)
	}
	if forwarded.headers.Get("CF-Connecting-IP") != "203.0.113.8" {
		t.Fatalf("upstream CF-Connecting-IP = %q", forwarded.headers.Get("CF-Connecting-IP"))
	}
	if forwarded.headers.Get("X-Forwarded-Proto") != "https" {
		t.Fatalf("upstream X-Forwarded-Proto = %q", forwarded.headers.Get("X-Forwarded-Proto"))
	}
	if !strings.HasPrefix(forwarded.headers.Get("X-Forwarded-For"), "203.0.113.8") {
		t.Fatalf("upstream X-Forwarded-For = %q", forwarded.headers.Get("X-Forwarded-For"))
	}
	counts, err := tracker.ArticleViewCounts(context.Background(), []string{"go-atomic-generics"})
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values["go-atomic-generics"] != 1 {
		t.Fatalf("view count = %d, want 1", counts.Values["go-atomic-generics"])
	}
}

func TestHealthChecksAnalyticsStorage(t *testing.T) {
	t.Parallel()

	tracker, articles := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics: tracker,
		Catalog:   articles,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "{\"status\":\"ok\"}\n" {
		t.Fatalf("health response = %d %q", response.Code, response.Body.String())
	}
}

func TestMetricsQueryRejectsMoreThanOneHundredArticles(t *testing.T) {
	t.Parallel()

	tracker, articles := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics: tracker,
		Catalog:   articles,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	subjectIDs := make([]string, 101)
	for index := range subjectIDs {
		subjectIDs[index] = "article-" + strconv.Itoa(index)
	}
	body, err := json.Marshal(map[string]any{
		"metric":       "article_unique_views",
		"subject_type": "article",
		"subject_ids":  subjectIDs,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/metrics/query", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestArticleProxyDoesNotCountIneligibleResponses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		method      string
		path        string
		status      int
		contentType string
	}{
		{name: "head request", method: http.MethodHead, path: "/posts/go-atomic-generics/", status: http.StatusOK, contentType: "text/html"},
		{name: "redirect", method: http.MethodGet, path: "/posts/go-atomic-generics/", status: http.StatusMovedPermanently, contentType: "text/html"},
		{name: "not found", method: http.MethodGet, path: "/posts/go-atomic-generics/", status: http.StatusNotFound, contentType: "text/html"},
		{name: "non html", method: http.MethodGet, path: "/posts/go-atomic-generics/", status: http.StatusOK, contentType: "application/json"},
		{name: "unknown article", method: http.MethodGet, path: "/posts/not-published/", status: http.StatusOK, contentType: "text/html"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", tt.contentType)
				response.WriteHeader(tt.status)
			}))
			t.Cleanup(upstream.Close)
			upstreamURL, err := url.Parse(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			tracker, articles := newBackend(t, nil)
			handler := httpserver.New(httpserver.Config{
				Analytics:       tracker,
				Catalog:         articles,
				ContentUpstream: upstreamURL,
				Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			request := httptest.NewRequest(tt.method, tt.path, nil)
			request.Header.Set("User-Agent", "Example Browser")
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			counts, err := tracker.ArticleViewCounts(context.Background(), []string{"go-atomic-generics"})
			if err != nil {
				t.Fatal(err)
			}
			if counts.Values["go-atomic-generics"] != 0 {
				t.Fatalf("view count = %d, want 0", counts.Values["go-atomic-generics"])
			}
		})
	}
}

func TestArticleProxyStorageFailureDoesNotChangeSuccessfulPage(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.Header().Set("X-Upstream", "blog")
		_, _ = response.Write([]byte("<article>still available</article>"))
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracker, articles := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics:       tracker,
		Catalog:         articles,
		ContentUpstream: upstreamURL,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err := tracker.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/posts/go-atomic-generics/", nil)
	request.Header.Set("User-Agent", "curl/8.14.1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "<article>still available</article>" {
		t.Fatalf("proxy response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("X-Upstream") != "blog" {
		t.Fatalf("upstream header = %q", response.Header().Get("X-Upstream"))
	}
}

func TestArticleProxyReturnsBadGatewayWhenUpstreamIsUnavailable(t *testing.T) {
	t.Parallel()

	upstreamURL, err := url.Parse("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	tracker, articles := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics:       tracker,
		Catalog:         articles,
		ContentUpstream: upstreamURL,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	request := httptest.NewRequest(http.MethodGet, "/posts/go-atomic-generics/", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("proxy response status = %d, body = %s", response.Code, response.Body.String())
	}
}

func newBackend(t *testing.T, articleSlugs []string) (*analytics.Tracker, *catalog.Catalog) {
	t.Helper()
	if articleSlugs == nil {
		articleSlugs = []string{"go-atomic-generics", "row-linked-list"}
	}
	sitemapPath := filepath.Join(t.TempDir(), "sitemap.xml")
	sitemap := `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
	for _, slug := range articleSlugs {
		sitemap += `<url><loc>https://blog.tursom.dev/posts/` + slug + `/</loc></url>`
	}
	sitemap += `</urlset>`
	if err := os.WriteFile(sitemapPath, []byte(sitemap), 0o600); err != nil {
		t.Fatal(err)
	}
	articles, err := catalog.Load(sitemapPath)
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	tracker, err := analytics.Open(context.Background(), analytics.Config{
		DatabasePath: filepath.Join(t.TempDir(), "turblog.sqlite"),
		HashKey:      []byte("0123456789abcdef0123456789abcdef"),
		Location:     location,
		ArticleSlugs: articles.Slugs(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracker.Close() })
	return tracker, articles
}

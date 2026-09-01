package httpserver_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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

const testBookAccessPassword = "0123456789abcdef0123456789abcdef"

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

func TestMetricsQueryReturnsBookChapterCountsSeparately(t *testing.T) {
	t.Parallel()

	tracker, content := newBackend(t, nil)
	_, err := tracker.RecordBookChapterView(context.Background(), analytics.ArticleView{
		Slug:       "guns-germs-steel/chapter-01",
		ClientIP:   "203.0.113.8",
		UserAgent:  "Example Browser",
		ClientKind: analytics.ClientBrowser,
		OccurredAt: time.Date(2026, 8, 24, 9, 0, 0, 0, time.FixedZone("CST", 8*60*60)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := httpserver.New(httpserver.Config{
		Analytics: tracker,
		Catalog:   content,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	body := bytes.NewBufferString(`{
		"metric":"book_chapter_unique_views",
		"subject_type":"book_chapter",
		"subject_ids":["guns-germs-steel/chapter-01","missing"]
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
	if payload.Metric != analytics.BookChapterUniqueViewsMetric || payload.Values["guns-germs-steel/chapter-01"] != 1 {
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

func TestPublicBookChapterProxyRecordsSuccessfulHTMLGet(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = response.Write([]byte("<article>chapter</article>"))
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracker, content := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics:       tracker,
		Catalog:         content,
		ContentUpstream: upstreamURL,
		Now:             func() time.Time { return time.Date(2026, 8, 24, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60)) },
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	request := httptest.NewRequest(http.MethodGet, "/books/guns-germs-steel/chapter-01/", nil)
	request.Header.Set("User-Agent", "Example Browser")
	request.Header.Set("X-Real-IP", "203.0.113.8")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "<article>chapter</article>" {
		t.Fatalf("proxy response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-cache, must-revalidate" {
		t.Fatalf("cache control = %q", response.Header().Get("Cache-Control"))
	}
	counts, err := tracker.BookChapterViewCounts(context.Background(), []string{"guns-germs-steel/chapter-01"})
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values["guns-germs-steel/chapter-01"] != 1 {
		t.Fatalf("view count = %d, want 1", counts.Values["guns-germs-steel/chapter-01"])
	}
}

func TestBookChapterAccessIsRequiredAndScopedToOnePath(t *testing.T) {
	t.Parallel()

	const password = testBookAccessPassword
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = response.Write([]byte("<article>" + request.URL.Path + "</article>"))
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracker, content := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics:          tracker,
		PrivateBookSlugs:   []string{"guns-germs-steel"},
		BookAccessPassword: []byte(password),
		Catalog:            content,
		ContentUpstream:    upstreamURL,
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		TrustProxyHeaders:  true,
	})

	lockedRequest := httptest.NewRequest(http.MethodGet, "/books/guns-germs-steel/chapter-01/", nil)
	lockedResponse := httptest.NewRecorder()
	handler.ServeHTTP(lockedResponse, lockedRequest)
	if lockedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("locked response status = %d", lockedResponse.Code)
	}
	if strings.Contains(lockedResponse.Body.String(), "<article>") {
		t.Fatal("locked response contains upstream chapter content")
	}
	if lockedResponse.Header().Get("Cache-Control") != "no-store" || !strings.Contains(lockedResponse.Header().Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("locked response headers = %#v", lockedResponse.Header())
	}

	publicRequest := httptest.NewRequest(http.MethodGet, "/books/guns-germs-steel/", nil)
	publicResponse := httptest.NewRecorder()
	handler.ServeHTTP(publicResponse, publicRequest)
	if publicResponse.Code != http.StatusOK || !strings.Contains(publicResponse.Body.String(), "/books/guns-germs-steel/") {
		t.Fatalf("public book page response = %d %q", publicResponse.Code, publicResponse.Body.String())
	}

	invalidBody := bytes.NewBufferString(`{"path":"/books/guns-germs-steel/chapter-01/","token":"invalid"}`)
	invalidRequest := httptest.NewRequest(http.MethodPost, "/api/v1/books/access", invalidBody)
	invalidRequest.Header.Set("Content-Type", "application/json")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalidRequest)
	if invalidResponse.Code != http.StatusForbidden {
		t.Fatalf("invalid token response = %d %q", invalidResponse.Code, invalidResponse.Body.String())
	}

	publicAccessBody := bytes.NewBufferString(`{"path":"/books/public-book/chapter-01/","token":"invalid"}`)
	publicAccessRequest := httptest.NewRequest(http.MethodPost, "/api/v1/books/access", publicAccessBody)
	publicAccessRequest.Header.Set("Content-Type", "application/json")
	publicAccessResponse := httptest.NewRecorder()
	handler.ServeHTTP(publicAccessResponse, publicAccessRequest)
	if publicAccessResponse.Code != http.StatusBadRequest {
		t.Fatalf("public book access response = %d %q", publicAccessResponse.Code, publicAccessResponse.Body.String())
	}

	chapterPath := "/books/guns-germs-steel/chapter-01/"
	token := bookAccessToken(chapterPath, password)
	validBody, err := json.Marshal(map[string]string{"path": chapterPath, "token": token})
	if err != nil {
		t.Fatal(err)
	}
	validRequest := httptest.NewRequest(http.MethodPost, "/api/v1/books/access", bytes.NewReader(validBody))
	validRequest.Header.Set("Content-Type", "application/json")
	validRequest.Header.Set("X-Forwarded-Proto", "https")
	validResponse := httptest.NewRecorder()
	handler.ServeHTTP(validResponse, validRequest)
	if validResponse.Code != http.StatusNoContent {
		t.Fatalf("valid token response = %d %q", validResponse.Code, validResponse.Body.String())
	}
	cookies := validResponse.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Path != chapterPath || !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatalf("access cookie = %#v", cookies)
	}

	authorizedRequest := httptest.NewRequest(http.MethodGet, chapterPath, nil)
	authorizedRequest.AddCookie(cookies[0])
	authorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResponse, authorizedRequest)
	if authorizedResponse.Code != http.StatusOK || !strings.Contains(authorizedResponse.Body.String(), "<article>") {
		t.Fatalf("authorized response = %d %q", authorizedResponse.Code, authorizedResponse.Body.String())
	}
	if authorizedResponse.Header().Get("Referrer-Policy") != "no-referrer" || !strings.Contains(authorizedResponse.Header().Get("Vary"), "Cookie") {
		t.Fatalf("authorized response headers = %#v", authorizedResponse.Header())
	}

	otherRequest := httptest.NewRequest(http.MethodGet, "/books/guns-germs-steel/chapter-02/", nil)
	otherRequest.AddCookie(cookies[0])
	otherResponse := httptest.NewRecorder()
	handler.ServeHTTP(otherResponse, otherRequest)
	if otherResponse.Code != http.StatusUnauthorized || strings.Contains(otherResponse.Body.String(), "<article>") {
		t.Fatalf("other chapter response = %d %q", otherResponse.Code, otherResponse.Body.String())
	}

	unknownRequest := httptest.NewRequest(http.MethodGet, "/books/guns-germs-steel/not-in-sitemap/", nil)
	unknownResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownResponse, unknownRequest)
	if unknownResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unknown chapter-shaped path response = %d", unknownResponse.Code)
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

func bookAccessToken(path, password string) string {
	mac := hmac.New(sha256.New, []byte(password))
	_, _ = mac.Write([]byte(path))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
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
	sitemap += `<url><loc>https://blog.tursom.dev/books/guns-germs-steel/chapter-01/</loc></url>`
	sitemap += `<url><loc>https://blog.tursom.dev/books/guns-germs-steel/chapter-02/</loc></url>`
	sitemap += `<url><loc>https://blog.tursom.dev/books/public-book/chapter-01/</loc></url>`
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
		DatabasePath:   filepath.Join(t.TempDir(), "turblog.sqlite"),
		HashKey:        []byte("0123456789abcdef0123456789abcdef"),
		Location:       location,
		ArticleSlugs:   articles.Slugs(),
		BookChapterIDs: articles.BookChapterIDs(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracker.Close() })
	return tracker, articles
}

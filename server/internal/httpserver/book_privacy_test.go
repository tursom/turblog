package httpserver_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/httpserver"
)

const (
	privateBookPath    = "/books/guns-germs-steel/"
	privateChapterPath = privateBookPath + "chapter-01/"
	secondChapterPath  = privateBookPath + "chapter-02/"
	ownerToken         = "0b7bBGl9qWXMvGUdEgMGNlkPKhLhvS85SJ0HL6cXHAs"
)

var shareKey = sync.OnceValue(func() []byte {
	key, err := pbkdf2.Key(sha256.New, testBookAccessPassword, []byte("turblog-book-access-v2"), 600000, 32)
	if err != nil {
		panic(err)
	}
	return key
})

func shareToken(path string) string {
	mac := hmac.New(sha256.New, shareKey())
	_, _ = mac.Write([]byte(path))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func privacyBackend(t *testing.T) (http.Handler, *analytics.Tracker) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Vary", "Accept-Encoding")
		if strings.Contains(r.URL.Path, "missing") {
			w.Header().Set("ETag", "upstream-missing")
			http.Error(w, "upstream resource missing: "+r.URL.Path, http.StatusNotFound)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/images/") {
			w.Header().Set("Content-Type", "image/png")
		} else {
			w.Header().Set("Content-Type", "text/html")
		}
		_, _ = io.WriteString(w, r.URL.Path)
	}))
	t.Cleanup(upstream.Close)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracker, content := newBackend(t, nil)
	return httpserver.New(httpserver.Config{
		Analytics: tracker, Catalog: content, ContentUpstream: upstreamURL,
		PrivateBookSlugs:   []string{"guns-germs-steel", "another-private"},
		BookAccessPassword: []byte(testBookAccessPassword),
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
	}), tracker
}

func privacyRequest(handler http.Handler, method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func assertBookHeaders(t *testing.T, w *httptest.ResponseRecorder, private bool) {
	t.Helper()
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(strings.Join(w.Header().Values("Vary"), ","), "Cookie") {
		t.Fatalf("privacy headers = %#v", w.Header())
	}
	if private && !strings.Contains(w.Header().Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("private response lacks noindex: %#v", w.Header())
	}
}

var nonceAttribute = regexp.MustCompile(`nonce="[^"]+"`)

func genericPage(w *httptest.ResponseRecorder) string {
	return nonceAttribute.ReplaceAllString(w.Body.String(), `nonce="NONCE"`)
}

func TestOwnerShelfAndSeparateGlobalLogin(t *testing.T) {
	t.Parallel()
	handler, _ := privacyBackend(t)
	owner := &http.Cookie{Name: "turblog_book_owner", Value: ownerToken}
	for _, path := range []string{"/books", "/books/", "/books/index.html"} {
		for _, authenticated := range []bool{false, true} {
			var cookies []*http.Cookie
			want := "/books/"
			if authenticated {
				cookies = append(cookies, owner)
				want = "/books/_owner/"
			}
			w := privacyRequest(handler, http.MethodGet, path, "", cookies...)
			if w.Code != http.StatusOK || w.Body.String() != want || w.Header().Get("Location") != "" {
				t.Fatalf("shelf %s owner=%v: %d %q", path, authenticated, w.Code, w.Body.String())
			}
			assertBookHeaders(t, w, authenticated)
		}
	}
	for _, path := range []string{"/books/_owner", "/books/_owner/", "/books/_owner/index.html"} {
		w := privacyRequest(handler, http.MethodGet, path, "", owner)
		if w.Code != http.StatusOK || w.Body.String() != "/books/_owner/" {
			t.Fatalf("owner full shelf %s: %d %q", path, w.Code, w.Body.String())
		}
		assertBookHeaders(t, w, true)
	}
	for _, path := range []string{"/books/public-book", "/books/public-book/index.html", "/books/public-book/chapter-01/index.html", "/images/books/public-book/cover.png"} {
		w := privacyRequest(handler, http.MethodGet, path, "")
		if w.Code != http.StatusOK {
			t.Fatalf("public route %s: %d", path, w.Code)
		}
		assertBookHeaders(t, w, false)
	}
	for _, path := range []string{"/_access/", "/books/_access", "/books/_access/", "/books/_access/index.html"} {
		w := privacyRequest(handler, http.MethodGet, path, "")
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `id="access-form"`) ||
			!strings.Contains(w.Body.String(), "PBKDF2") || !strings.Contains(w.Body.String(), "path: destination") ||
			!strings.Contains(w.Body.String(), "location.assign(destination)") || strings.Contains(w.Body.String(), "sharedToken") {
			t.Fatalf("login %s: %d %q", path, w.Code, w.Body.String())
		}
		assertBookHeaders(t, w, true)
	}
	w := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", `{"path":"/books/","owner_token":"`+ownerToken+`"}`)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/books/" {
		t.Fatalf("global login = %d %#v %s", w.Code, w.Header(), w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Path != "/" || !cookies[0].HttpOnly || cookies[0].MaxAge != 30*24*60*60 {
		t.Fatalf("owner cookies = %#v", cookies)
	}
	assertBookHeaders(t, w, false)
	// Even an empty catalog or a nonexistent path cannot prevent owner login.
	empty := httpserver.New(httpserver.Config{BookAccessPassword: []byte(testBookAccessPassword)})
	for _, path := range []string{"/books/", "/books/not-real/", "", "/not-a-book"} {
		body, _ := json.Marshal(map[string]string{"path": path, "owner_token": ownerToken})
		w := privacyRequest(empty, http.MethodPost, "/api/v1/books/access", string(body))
		if w.Code != http.StatusNoContent && w.Code != http.StatusSeeOther {
			t.Fatalf("resource-independent owner login %q: %d %s", path, w.Code, w.Body.String())
		}
	}
}

func TestBookPrivacyUniform404AndPathBypasses(t *testing.T) {
	t.Parallel()
	handler, _ := privacyBackend(t)
	baseline := privacyRequest(handler, http.MethodGet, "/books/unknown/", "")
	paths := []string{
		privateBookPath, privateChapterPath, "/books/unknown", "/books/unknown/index.html",
		"/books/public-book/unknown/", privateBookPath + "unknown/", "/books/_owner",
		"/books/_owner/", "/books/_owner/index.html", "/books/_owner/index.html/",
		"/books/_owner/anything", "/books/_owner/index.html/anything", "/books/_owner//",
		"/books//_owner/", "/books/./_owner/", "/books/public-book/../_owner/",
		"/books/%2e/_owner/", "/books/%2e%2e/books/_owner/", "/%62ooks/_owner/",
		"/books%2f_owner/index.html", "/books/%5fowner/", "/books/%255fowner/",
		"/books/%5c_owner/", "/books/_owner%00/", "/books/guns-germs-steel",
		"/books%2fguns-germs-steel/chapter-01/", "/%62ooks/guns-germs-steel/chapter-01/",
		"/images%2fbooks/guns-germs-steel/cover.png", "/images/books/%67uns-germs-steel/cover.png",
		privateBookPath + "index.html", privateChapterPath + "index.html", strings.TrimSuffix(privateChapterPath, "/"),
		"/_internal", "/_internal/", "/_internal/content-catalog.json", "/%5finternal/content-catalog.json",
		"/book-access-manifest.json", "/book-access-manifest.json/", "/%62ook-access-manifest.json",
		"/images/books/guns-germs-steel/cover.png", "/images/books/unknown/cover.png",
		"/images/books/public-book/missing.png", "/images/books/guns-germs-steel/missing.png",
		"/images/books/public-book/../guns-germs-steel/cover.png", "/images/books/public-book/%2e%2e/guns-germs-steel/cover.png",
		"/images/books", "/images/books/", "/images/books/guns-germs-steel/",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			w := privacyRequest(handler, http.MethodGet, path, "")
			if w.Code != http.StatusNotFound || genericPage(w) != genericPage(baseline) || w.Header().Get("Location") != "" {
				t.Fatalf("nonuniform 404: %d %q", w.Code, w.Body.String())
			}
			assertBookHeaders(t, w, true)
			if strings.Contains(w.Body.String(), `id="access-form"`) || !strings.Contains(w.Body.String(), "get('access')") ||
				!strings.Contains(w.Body.String(), "token: sharedToken") || strings.Contains(w.Body.String(), "PBKDF2") {
				t.Fatal("generic 404 must consume share fragments without rendering login")
			}
		})
	}
	for _, path := range []string{"/_internal/content-catalog.json", "/book-access-manifest.json", "/books/unknown/"} {
		w := privacyRequest(handler, http.MethodGet, path, "", &http.Cookie{Name: "turblog_book_owner", Value: ownerToken})
		if w.Code != http.StatusNotFound || genericPage(w) != genericPage(baseline) {
			t.Fatalf("owner must not bypass unknown/internal route %s: %d", path, w.Code)
		}
	}
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodOptions} {
		w := privacyRequest(handler, method, privateChapterPath, "")
		if w.Code != http.StatusNotFound {
			t.Fatalf("method %s exposes private route: %d", method, w.Code)
		}
	}
}

func TestGrantAPIDoesNotEnumeratePaths(t *testing.T) {
	t.Parallel()
	handler, _ := privacyBackend(t)
	for _, credential := range []string{"token", "owner_token"} {
		var baseline string
		for _, path := range []string{privateChapterPath, privateBookPath, "/books/public-book/", "/books/public-book/chapter-01/", "/books/unknown/", privateBookPath + "unknown/", "/books/", "/books/_owner/", "/", "", privateBookPath + "index.html", "/books//guns-germs-steel/"} {
			body, _ := json.Marshal(map[string]string{"path": path, credential: "invalid"})
			w := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", string(body))
			if baseline == "" {
				baseline = w.Body.String()
			}
			if w.Code != http.StatusForbidden || w.Body.String() != baseline || len(w.Result().Cookies()) != 0 {
				t.Fatalf("%s reveals path %q: %d %s", credential, path, w.Code, w.Body.String())
			}
			assertBookHeaders(t, w, false)
		}
	}
	for _, path := range []string{privateChapterPath + "index.html", strings.TrimSuffix(privateChapterPath, "/"), "/books/unknown/", privateBookPath + "unknown/", "/books/public-book/"} {
		body, _ := json.Marshal(map[string]string{"path": path, "token": shareToken(path)})
		w := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", string(body))
		if w.Code != http.StatusForbidden {
			t.Fatalf("noncanonical or nonexistent share %s = %d", path, w.Code)
		}
	}
}

func TestSharesKeepScopeAcrossAliasesImagesAndMetrics(t *testing.T) {
	t.Parallel()
	handler, tracker := privacyBackend(t)
	_, err := tracker.RecordBookChapterView(context.Background(), analytics.ArticleView{
		Slug: "guns-germs-steel/chapter-01", ClientIP: "203.0.113.1", UserAgent: "Browser",
		ClientKind: analytics.ClientBrowser, OccurredAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{privateChapterPath, privateBookPath} {
		t.Run(scope, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"path": scope, "token": shareToken(scope)})
			grant := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", string(body))
			if grant.Code != http.StatusNoContent {
				t.Fatalf("grant = %d %s", grant.Code, grant.Body.String())
			}
			cookies := grant.Result().Cookies()
			if len(cookies) != 2 || cookies[0].Path != scope || cookies[1].Path != "/" || cookies[0].Value != shareToken(scope) || cookies[1].Value != shareToken(scope) {
				t.Fatalf("share cookies = %#v", cookies)
			}
			// Only send the new root cookie, as a browser does for stats and images.
			cookie := cookies[1]
			for _, path := range []string{privateChapterPath, strings.TrimSuffix(privateChapterPath, "/"), privateChapterPath + "index.html", "/images/books/guns-germs-steel/cover.png", "/images/books/guns-germs-steel/nested/page.png"} {
				w := privacyRequest(handler, http.MethodGet, path, "", cookie)
				if w.Code != http.StatusOK {
					t.Fatalf("shared %s: %d %s", path, w.Code, w.Body.String())
				}
				assertBookHeaders(t, w, true)
			}
			for _, path := range []string{privateBookPath, secondChapterPath} {
				want := http.StatusNotFound
				if scope == privateBookPath {
					want = http.StatusOK
				}
				w := privacyRequest(handler, http.MethodGet, path, "", cookie)
				if w.Code != want {
					t.Fatalf("scope %s on %s = %d, want %d", scope, path, w.Code, want)
				}
			}
			for _, path := range []string{"/books/_owner/index.html", "/books/another-private/chapter-01/", "/images/books/another-private/cover.png", "/images/books/guns-germs-steel/missing.png"} {
				w := privacyRequest(handler, http.MethodGet, path, "", cookie)
				if w.Code != http.StatusNotFound {
					t.Fatalf("scope escaped on %s: %d", path, w.Code)
				}
			}
			w := privacyRequest(handler, http.MethodGet, "/books/", "", cookie)
			if w.Body.String() != "/books/" {
				t.Fatal("share exposed full shelf")
			}
			stats := privacyRequest(handler, http.MethodPost, "/api/v1/analytics/metrics/query", `{"metric":"book_chapter_unique_views","subject_type":"book_chapter","subject_ids":["guns-germs-steel/chapter-01","guns-germs-steel/chapter-02","another-private/chapter-01","unknown"]}`, cookie)
			var result struct {
				Values  map[string]int64 `json:"values"`
				Unknown []string         `json:"unknown"`
			}
			if err := json.Unmarshal(stats.Body.Bytes(), &result); err != nil || stats.Code != http.StatusOK {
				t.Fatalf("stats: %d %s, error %v", stats.Code, stats.Body.String(), err)
			}
			if result.Values["guns-germs-steel/chapter-01"] < 1 {
				t.Fatalf("authorized stats missing: %#v", result)
			}
			_, second := result.Values["guns-germs-steel/chapter-02"]
			_, other := result.Values["another-private/chapter-01"]
			if second != (scope == privateBookPath) || other {
				t.Fatalf("stats scope incorrect: %#v", result)
			}
			assertBookHeaders(t, stats, false)
		})
	}
	anonymous := privacyRequest(handler, http.MethodPost, "/api/v1/analytics/metrics/query", `{"metric":"book_chapter_unique_views","subject_type":"book_chapter","subject_ids":["guns-germs-steel/chapter-01","guns-germs-steel/missing","unknown","public-book/chapter-01","guns-germs-steel/chapter-01"]}`)
	if anonymous.Code != http.StatusOK || anonymous.Body.String() != "{\"metric\":\"book_chapter_unique_views\",\"values\":{\"public-book/chapter-01\":0},\"unknown\":[\"guns-germs-steel/chapter-01\",\"guns-germs-steel/missing\",\"unknown\"]}\n" {
		t.Fatalf("anonymous stats enumerate: %d %s", anonymous.Code, anonymous.Body.String())
	}
	owner := &http.Cookie{Name: "turblog_book_owner", Value: ownerToken}
	for _, path := range []string{privateBookPath, secondChapterPath, "/books/another-private/chapter-01/", "/images/books/another-private/cover.png"} {
		w := privacyRequest(handler, http.MethodGet, path, "", owner)
		if w.Code != http.StatusOK {
			t.Fatalf("owner %s: %d", path, w.Code)
		}
	}
	ownerStats := privacyRequest(handler, http.MethodPost, "/api/v1/analytics/metrics/query", `{"metric":"book_chapter_unique_views","subject_type":"book_chapter","subject_ids":["another-private/chapter-01"]}`, owner)
	if ownerStats.Code != http.StatusOK || !strings.Contains(ownerStats.Body.String(), `"another-private/chapter-01":`) {
		t.Fatalf("owner stats: %d %s", ownerStats.Code, ownerStats.Body.String())
	}
}

func TestMultipleSharesAndLegacyCookiePromotion(t *testing.T) {
	t.Parallel()
	handler, _ := privacyBackend(t)
	origin := httptest.NewServer(handler)
	t.Cleanup(origin.Close)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	for _, scope := range []string{privateChapterPath, secondChapterPath} {
		body, _ := json.Marshal(map[string]string{"path": scope, "token": shareToken(scope)})
		response, err := client.Post(origin.URL+"/api/v1/books/access", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			t.Fatalf("share %s: %d", scope, response.StatusCode)
		}
	}
	for _, path := range []string{privateChapterPath, secondChapterPath, "/images/books/guns-germs-steel/cover.png"} {
		response, err := client.Get(origin.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("multiple shares %s: %d", path, response.StatusCode)
		}
	}
	rootURL, _ := url.Parse(origin.URL + "/")
	if len(jar.Cookies(rootURL)) != 2 {
		t.Fatalf("root shares overwrite each other: %#v", jar.Cookies(rootURL))
	}
	legacyJar, _ := cookiejar.New(nil)
	legacyJar.SetCookies(rootURL, []*http.Cookie{
		{Name: testBookAccessCookieName, Value: shareToken(privateChapterPath), Path: privateChapterPath},
		{Name: testBookAccessCookieName, Value: shareToken(secondChapterPath), Path: secondChapterPath},
	})
	client.Jar = legacyJar
	for _, path := range []string{privateChapterPath, secondChapterPath, "/images/books/guns-germs-steel/cover.png"} {
		response, err := client.Get(origin.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("legacy share %s: %d", path, response.StatusCode)
		}
	}
	if len(legacyJar.Cookies(rootURL)) != 2 {
		t.Fatalf("legacy shares not promoted independently: %#v", legacyJar.Cookies(rootURL))
	}
	w := privacyRequest(handler, http.MethodGet, privateBookPath, "", legacyJar.Cookies(rootURL)...)
	if w.Code != http.StatusNotFound {
		t.Fatal("combined chapter shares widened to book access")
	}
	// A cryptographically valid token for an invented chapter grants no images.
	w = privacyRequest(handler, http.MethodGet, "/images/books/guns-germs-steel/cover.png", "",
		&http.Cookie{Name: testBookAccessCookieName, Value: shareToken(privateBookPath + "invented/")})
	if w.Code != http.StatusNotFound {
		t.Fatal("invented chapter token grants media access")
	}
}

func TestPrivateContentFailsClosedWithoutPasswordOrUpstream(t *testing.T) {
	t.Parallel()
	tracker, content := newBackend(t, nil)
	handler := httpserver.New(httpserver.Config{
		Analytics: tracker, Catalog: content, PrivateBookSlugs: []string{"guns-germs-steel"},
	})
	for _, path := range []string{privateBookPath, privateChapterPath, "/books/_owner/", "/images/books/guns-germs-steel/cover.png", "/books/unknown/"} {
		w := privacyRequest(handler, http.MethodGet, path, "",
			&http.Cookie{Name: "turblog_book_owner", Value: ownerToken},
			&http.Cookie{Name: testBookAccessCookieName, Value: shareToken(privateBookPath)})
		if w.Code != http.StatusNotFound {
			t.Fatalf("unconfigured private route %s: %d", path, w.Code)
		}
		assertBookHeaders(t, w, true)
	}
	for _, credential := range []string{"token", "owner_token"} {
		body, _ := json.Marshal(map[string]string{"path": privateBookPath, credential: shareToken(privateBookPath)})
		w := privacyRequest(handler, http.MethodPost, "/api/v1/books/access", string(body))
		if w.Code != http.StatusForbidden {
			t.Fatalf("unconfigured credential %s: %d", credential, w.Code)
		}
	}
	login := privacyRequest(handler, http.MethodGet, "/books/_access/", "")
	if login.Code != http.StatusOK {
		t.Fatalf("login requires content upstream: %d", login.Code)
	}
}

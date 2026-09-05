package httpserver

import (
	"bytes"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/tursom/turblog/server/internal/catalog"
)

const (
	bookAccessCookieName       = "turblog_book_access"
	bookOwnerCookieName        = "turblog_book_owner"
	bookOwnerTokenPurpose      = "turblog-book-owner-v1"
	bookOwnerCookieMaxAge      = 30 * 24 * 60 * 60
	bookAccessPBKDF2Iterations = 600_000
	bookAccessPBKDF2Salt       = "turblog-book-access-v2"
)

var bookAccessPage = template.Must(template.New("book-access").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>{{if .Login}}主人登录{{else}}404 · 页面未找到{{end}} · Tursom Log</title>
  <style nonce="{{.Nonce}}">
    :root { color-scheme: light; --bg: #f5f6f4; --panel: #fff; --text: #171918; --muted: #686d69; --line: #d7dbd7; --accent: #1b6547; --danger: #9f342e; }
    @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #171918; --panel: #202321; --text: #f1f3f1; --muted: #a8aea9; --line: #3b403c; --accent: #79cfa8; --danger: #ff9288; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { height: 58px; border-bottom: 1px solid var(--line); background: var(--panel); }
    header div { width: min(100% - 32px, 1080px); height: 100%; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    header a { color: var(--text); font-weight: 700; text-decoration: none; }
    header span { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { width: min(100% - 32px, 560px); margin: 0 auto; padding: clamp(64px, 14vh, 140px) 0 80px; }
    .kicker { margin: 0 0 12px; color: var(--accent); font: 700 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    h1 { margin: 0; font-size: clamp(28px, 7vw, 40px); line-height: 1.15; letter-spacing: 0; }
    .lead { margin: 18px 0 32px; color: var(--muted); font-size: 16px; line-height: 1.75; }
    form { padding-top: 24px; border-top: 1px solid var(--line); }
    label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 650; }
    input { width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); color: var(--text); font: inherit; }
    input:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    button { min-height: 42px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 4px; font-family: inherit; font-size: 14px; font-weight: 650; cursor: pointer; }
    button[type="submit"] { background: var(--accent); color: var(--panel); }
    button[type="button"] { background: transparent; color: var(--accent); }
    button:disabled { cursor: wait; opacity: .65; }
    #status { min-height: 24px; margin: 14px 0 0; color: var(--muted); font-size: 14px; }
    #status.error { color: var(--danger); }
  </style>
</head>
<body>
  <header><div><a href="/">Tursom Log</a></div></header>
  <main>
    {{if .Login}}
    <p class="kicker">OWNER LOGIN</p>
    <h1>主人登录</h1>
    <p class="lead">输入站点主密码。</p>
    <form id="access-form">
      <label for="password">站点主密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required autofocus>
      <div class="actions">
        <button type="submit">登录</button>
      </div>
      <p id="status" role="status" aria-live="polite"></p>
    </form>
    {{else}}
    <p class="kicker">404</p>
    <h1>页面未找到</h1>
    <p class="lead">请求的页面不存在。</p>
    {{end}}
  </main>
  <script nonce="{{.Nonce}}">
    {{if .Login}}
    const form = document.querySelector('#access-form');
    const passwordInput = document.querySelector('#password');
    const status = document.querySelector('#status');
    const buttons = Array.from(document.querySelectorAll('button'));

    function setStatus(message, isError = false) {
      status.textContent = message;
      status.classList.toggle('error', isError);
    }

    function setBusy(busy) {
      buttons.forEach((button) => { button.disabled = busy; });
      passwordInput.disabled = busy;
    }

    function base64url(bytes) {
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }

    async function signingKeyFor(password) {
      const encoder = new TextEncoder();
      const passwordKey = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
      );
      const derivedKey = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          iterations: 600000,
          salt: encoder.encode('turblog-book-access-v2'),
        },
        passwordKey,
        256
      );
      return crypto.subtle.importKey(
        'raw', derivedKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
    }

    async function tokenFor(signingKey, message) {
      const token = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(message));
      return base64url(new Uint8Array(token));
    }

    const defaultDestination = location.pathname.startsWith('/books/') ? '/books/' : '/';
    const requestedDestination = new URLSearchParams(location.search).get('return_to');
    let destination = defaultDestination;
    if (requestedDestination && requestedDestination.startsWith('/') && !requestedDestination.startsWith('//')) {
      const target = new URL(requestedDestination, location.origin);
      if (target.origin === location.origin && (
        target.pathname === '/' || /^\/(?:books|posts|archive|tags)\//.test(target.pathname)
      )) destination = target.pathname;
    }

    async function unlock(credentials) {
      const response = await fetch('/api/v1/books/access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destination, ...credentials }),
      });
      if (!response.ok) throw new Error('access denied');
      location.assign(destination);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(true);
      setStatus('正在验证…');
      try {
        const signingKey = await signingKeyFor(passwordInput.value);
        const ownerToken = await tokenFor(signingKey, 'turblog-book-owner-v1');
        await unlock({ owner_token: ownerToken });
      } catch {
        setBusy(false);
        setStatus('密码不正确。', true);
        passwordInput.select();
      }
    });

    {{else}}
    const sharedToken = new URLSearchParams(location.hash.slice(1)).get('access');
    if (sharedToken) {
      history.replaceState(null, '', location.pathname + location.search);
      const path = location.pathname.replace(/index\.html$/, '').replace(/\/?$/, '/');
      fetch('/api/v1/books/access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, token: sharedToken }),
      }).then((response) => {
        if (response.ok) location.reload();
      }).catch(() => {});
    }
    {{end}}
  </script>
</body>
</html>`))

type bookAccessRequest struct {
	Path       string `json:"path"`
	Token      string `json:"token"`
	OwnerToken string `json:"owner_token"`
}

func (s *server) grantBookAccess(response http.ResponseWriter, request *http.Request) {
	bookPrivacyHeaders(response.Header())
	if mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var access bookAccessRequest
	if err := decoder.Decode(&access); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "request body must contain one valid JSON object")
		return
	}
	if (access.Token == "") == (access.OwnerToken == "") {
		writeError(response, http.StatusBadRequest, "invalid_request", "request must contain exactly one access token")
		return
	}
	if access.OwnerToken != "" {
		if !s.validBookOwnerToken(access.OwnerToken) {
			writeError(response, http.StatusForbidden, "invalid_book_access", "book access token is invalid")
			return
		}
		http.SetCookie(response, &http.Cookie{
			Name:     bookOwnerCookieName,
			Value:    access.OwnerToken,
			Path:     "/",
			MaxAge:   bookOwnerCookieMaxAge,
			Expires:  s.now().Add(time.Duration(bookOwnerCookieMaxAge) * time.Second),
			HttpOnly: true,
			Secure:   s.secureBookCookie(request),
			SameSite: http.SameSiteLaxMode,
		})
		if access.Path == "/books/" || access.Path == "/" {
			http.Redirect(response, request, access.Path, http.StatusSeeOther)
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	// Authenticate the unchanged canonical-path token before consulting the catalog.
	if !s.validBookAccessToken(access.Path, access.Token) || !s.isProtectedContent(access.Path) ||
		!s.containsContentPath(access.Path) {
		writeError(response, http.StatusForbidden, "invalid_book_access", "book access token is invalid")
		return
	}
	// Keep legacy path cookies, and retain each share independently at the root so
	// the same credentials reach images and the metrics API without widening scope.
	cookie := &http.Cookie{
		Name:     bookAccessCookieName,
		Value:    access.Token,
		Path:     access.Path,
		HttpOnly: true,
		Secure:   s.secureBookCookie(request),
		SameSite: http.SameSiteLaxMode,
	}
	http.SetCookie(response, cookie)
	s.setBookRootShareCookie(response, request, access.Path, access.Token)
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusNoContent)
}

func (s *server) setBookRootShareCookie(response http.ResponseWriter, request *http.Request, path, token string) {
	pathHash := sha256.Sum256([]byte(path))
	name := bookAccessCookieName + "_" + base64.RawURLEncoding.EncodeToString(pathHash[:])
	for _, cookie := range request.Cookies() {
		if cookie.Name == name && cookie.Value == token {
			return
		}
	}
	http.SetCookie(response, &http.Cookie{
		Name: name, Value: token, Path: "/", HttpOnly: true,
		Secure: s.secureBookCookie(request), SameSite: http.SameSiteLaxMode,
	})
}

// Promote existing path-scoped shares when their page is visited, without
// converting chapter grants into whole-book grants or replacing other shares.
func (s *server) promoteLegacyBookShares(response http.ResponseWriter, request *http.Request, path string) {
	slug, ok := catalog.BookSlugFromContentPath(path)
	if !ok {
		return
	}
	for _, cookie := range request.Cookies() {
		if cookie.Name != bookAccessCookieName {
			continue
		}
		for _, scope := range []string{path, "/books/" + slug + "/"} {
			if s.validBookAccessToken(scope, cookie.Value) {
				s.setBookRootShareCookie(response, request, scope, cookie.Value)
				break
			}
		}
	}
}

type bookShareRequest struct {
	Path string `json:"path"`
}

type bookShareResponse struct {
	Token string `json:"token"`
}

func (s *server) createBookShareToken(response http.ResponseWriter, request *http.Request) {
	bookPrivacyHeaders(response.Header())
	if !s.hasBookOwnerAccess(request) {
		writeError(response, http.StatusForbidden, "owner_access_required", "owner access is required")
		return
	}
	if mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var share bookShareRequest
	if err := decoder.Decode(&share); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "request body must contain one valid JSON object")
		return
	}
	if !s.isProtectedContent(share.Path) {
		writeError(response, http.StatusBadRequest, "book_access_not_required", "book does not require access authorization")
		return
	}
	if !s.containsContentPath(share.Path) {
		writeError(response, http.StatusBadRequest, "invalid_book_path", "book content path is invalid")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, bookShareResponse{Token: s.bookAccessToken(share.Path)})
}

func (s *server) secureBookCookie(request *http.Request) bool {
	return request.TLS != nil || (s.trustProxyHeaders && strings.EqualFold(request.Header.Get("X-Forwarded-Proto"), "https"))
}

func isBookShareCookie(cookie *http.Cookie) bool {
	return cookie.Name == bookAccessCookieName || strings.HasPrefix(cookie.Name, bookAccessCookieName+"_")
}

func (s *server) hasBookPathAccess(request *http.Request, path string) bool {
	if s.hasBookOwnerAccess(request) {
		return true
	}
	bookSlug, isBookContent := catalog.BookSlugFromContentPath(path)
	if !isBookContent && !s.isProtectedPostContent(path) {
		return false
	}
	bookPath := "/books/" + bookSlug + "/"
	for _, cookie := range request.Cookies() {
		if !isBookShareCookie(cookie) {
			continue
		}
		if s.validBookAccessToken(path, cookie.Value) || isBookContent && s.validBookAccessToken(bookPath, cookie.Value) {
			return true
		}
	}
	return false
}

func (s *server) hasBookOwnerAccess(request *http.Request) bool {
	for _, cookie := range request.Cookies() {
		if cookie.Name == bookOwnerCookieName && s.validBookOwnerToken(cookie.Value) {
			return true
		}
	}
	return false
}

func deriveBookAccessKey(password []byte) []byte {
	if len(password) == 0 {
		return nil
	}
	key, err := pbkdf2.Key(
		sha256.New,
		string(password),
		[]byte(bookAccessPBKDF2Salt),
		bookAccessPBKDF2Iterations,
		sha256.Size,
	)
	if err != nil {
		return nil
	}
	return key
}

func (s *server) validBookOwnerToken(encodedToken string) bool {
	provided, err := base64.RawURLEncoding.DecodeString(encodedToken)
	if err != nil || len(provided) != sha256.Size || len(s.bookAccessKey) == 0 {
		return false
	}
	mac := hmac.New(sha256.New, s.bookAccessKey)
	_, _ = mac.Write([]byte(bookOwnerTokenPurpose))
	return hmac.Equal(provided, mac.Sum(nil))
}

func (s *server) bookAccessToken(path string) string {
	if len(s.bookAccessKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, s.bookAccessKey)
	_, _ = mac.Write([]byte(path))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *server) validBookAccessToken(path, encodedToken string) bool {
	if len(s.bookAccessKey) == 0 {
		return false
	}
	provided, err := base64.RawURLEncoding.DecodeString(encodedToken)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, s.bookAccessKey)
	_, _ = mac.Write([]byte(path))
	return hmac.Equal(provided, mac.Sum(nil))
}

func (s *server) serveBookAccess(response http.ResponseWriter, login bool) {
	page, err := s.bookAccessResponse(login)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error", "unable to render page")
		return
	}
	for name, values := range page.Header {
		response.Header()[name] = values
	}
	response.WriteHeader(page.StatusCode)
	_, _ = io.Copy(response, page.Body)
}

func (s *server) bookAccessResponse(login bool) (*http.Response, error) {
	nonceBytes := make([]byte, 18)
	if _, err := rand.Read(nonceBytes); err != nil {
		return nil, err
	}
	data := struct {
		Nonce string
		Login bool
	}{Nonce: base64.RawURLEncoding.EncodeToString(nonceBytes), Login: login}
	var page bytes.Buffer
	if err := bookAccessPage.Execute(&page, data); err != nil {
		return nil, err
	}
	header := make(http.Header)
	bookPrivacyHeaders(header)
	header.Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+data.Nonce+"'; style-src 'nonce-"+data.Nonce+"'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Robots-Tag", "noindex, noarchive")
	status := http.StatusNotFound
	if login {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode:    status,
		Header:        header,
		Body:          io.NopCloser(&page),
		ContentLength: int64(page.Len()),
	}, nil
}

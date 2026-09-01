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
	"mime"
	"net/http"
	"strings"
)

const (
	bookAccessCookieName       = "turblog_book_access"
	bookAccessPBKDF2Iterations = 600_000
	bookAccessPBKDF2Salt       = "turblog-book-access-v2"
)

var bookAccessPage = template.Must(template.New("book-access").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>图书内容已锁定 · Tursom Log</title>
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
  <header><div><a href="/">Tursom Log</a><span>PRIVATE READING</span></div></header>
  <main>
    <p class="kicker">BOOK ACCESS</p>
    <h1>图书内容已锁定</h1>
    <p class="lead">输入站点主密码以阅读本页，或打开主人分享的完整链接。</p>
    <form id="access-form">
      <label for="password">站点主密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required autofocus>
      <div class="actions">
        <button type="submit">解锁并阅读</button>
        <button id="copy-link" type="button">复制本页分享链接</button>
      </div>
      <p id="status" role="status" aria-live="polite"></p>
    </form>
  </main>
  <script nonce="{{.Nonce}}">
    const form = document.querySelector('#access-form');
    const passwordInput = document.querySelector('#password');
    const copyButton = document.querySelector('#copy-link');
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

    async function tokenFor(password) {
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
      const signingKey = await crypto.subtle.importKey(
        'raw', derivedKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const token = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(location.pathname));
      return base64url(new Uint8Array(token));
    }

    async function unlock(token) {
      const response = await fetch('/api/v1/books/access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname, token }),
      });
      if (!response.ok) throw new Error('access denied');
      history.replaceState(null, '', location.pathname + location.search);
      location.reload();
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(true);
      setStatus('正在验证…');
      try {
        await unlock(await tokenFor(passwordInput.value));
      } catch {
        setBusy(false);
        setStatus('密码不正确。', true);
        passwordInput.select();
      }
    });

    copyButton.addEventListener('click', async () => {
      if (!passwordInput.reportValidity()) return;
      setBusy(true);
      try {
        const token = await tokenFor(passwordInput.value);
        const link = location.origin + location.pathname + '#access=' + token;
        await navigator.clipboard.writeText(link);
        setStatus('本页分享链接已复制。');
      } catch {
        setStatus('无法复制链接，请确认浏览器允许剪贴板访问。', true);
      } finally {
        setBusy(false);
      }
    });

    const sharedToken = new URLSearchParams(location.hash.slice(1)).get('access');
    if (sharedToken) {
      setBusy(true);
      setStatus('正在验证分享链接…');
      unlock(sharedToken).catch(() => {
        history.replaceState(null, '', location.pathname + location.search);
        setBusy(false);
        setStatus('分享链接无效，或站点主密码已经更换。', true);
      });
    }
  </script>
</body>
</html>`))

type bookAccessRequest struct {
	Path  string `json:"path"`
	Token string `json:"token"`
}

func (s *server) grantBookAccess(response http.ResponseWriter, request *http.Request) {
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
	if !s.isProtectedBookChapter(access.Path) {
		writeError(response, http.StatusBadRequest, "book_access_not_required", "book does not require access authorization")
		return
	}
	if _, ok := s.catalog.BookChapterIDFromPath(access.Path); !ok || !s.validBookAccessToken(access.Path, access.Token) {
		writeError(response, http.StatusForbidden, "invalid_book_access", "book access token is invalid")
		return
	}
	http.SetCookie(response, &http.Cookie{
		Name:     bookAccessCookieName,
		Value:    access.Token,
		Path:     access.Path,
		HttpOnly: true,
		Secure:   request.TLS != nil || (s.trustProxyHeaders && strings.EqualFold(request.Header.Get("X-Forwarded-Proto"), "https")),
		SameSite: http.SameSiteLaxMode,
	})
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusNoContent)
}

func (s *server) hasBookAccess(request *http.Request) bool {
	cookie, err := request.Cookie(bookAccessCookieName)
	return err == nil && s.validBookAccessToken(request.URL.Path, cookie.Value)
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

func (s *server) serveBookAccess(response http.ResponseWriter) {
	nonceBytes := make([]byte, 18)
	if _, err := rand.Read(nonceBytes); err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error", "unable to render book access page")
		return
	}
	data := struct{ Nonce string }{Nonce: base64.RawURLEncoding.EncodeToString(nonceBytes)}
	var page bytes.Buffer
	if err := bookAccessPage.Execute(&page, data); err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error", "unable to render book access page")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+data.Nonce+"'; style-src 'nonce-"+data.Nonce+"'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("X-Robots-Tag", "noindex, noarchive")
	response.WriteHeader(http.StatusUnauthorized)
	_, _ = response.Write(page.Bytes())
}

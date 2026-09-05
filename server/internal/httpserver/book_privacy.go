package httpserver

import (
	"net/http"
	"path"
	"strings"
)

func bookPrivacyHeaders(header http.Header) {
	header.Set("Cache-Control", "no-store")
	for _, value := range header.Values("Vary") {
		for _, field := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(field), "Cookie") {
				return
			}
		}
	}
	header.Add("Vary", "Cookie")
}

func routeWithin(value, root string) bool {
	return value == root || strings.HasPrefix(value, root+"/")
}

func bookResponsePath(value string) bool {
	return routeWithin(value, "/books") || routeWithin(value, "/images/books")
}

// Reject ambiguous paths before ServeMux can redirect or the static upstream can
// normalize them differently. Canonical book aliases are resolved only after this.
func (s *server) privacyGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		value := request.URL.Path
		clean := path.Clean(value)
		if strings.ContainsAny(value, "\\%\x00") || strings.Contains(value, "//") ||
			(clean != value && clean+"/" != value) {
			s.serveBookAccess(response, false)
			return
		}
		if routeWithin(value, "/_internal") || routeWithin(value, "/_content") || routeWithin(value, "/_owner") ||
			routeWithin(value, "/book-access-manifest.json") || routeWithin(value, "/post-access-manifest.json") {
			s.serveBookAccess(response, false)
			return
		}
		next.ServeHTTP(response, request)
	})
}

func canonicalBookPath(value string) string {
	value = strings.TrimSuffix(value, "/index.html")
	return strings.TrimSuffix(value, "/") + "/"
}

func (s *server) hasBookImageAccess(request *http.Request, slug string) bool {
	if s.hasBookPathAccess(request, "/books/"+slug+"/") {
		return true
	}
	// A chapter share permits media from that book, but never its other pages.
	// Validate against actual catalog chapters; a token for an invented path is
	// not a media grant. Legacy duplicate-name cookies remain valid as well.
	cookies := request.Cookies()
	if len(cookies) == 0 {
		return false
	}
	for _, id := range s.catalog.BookChapterIDs() {
		if !strings.HasPrefix(id, slug+"/") {
			continue
		}
		for _, cookie := range cookies {
			if isBookShareCookie(cookie) && s.validBookAccessToken("/books/"+id+"/", cookie.Value) {
				return true
			}
		}
	}
	return false
}

// prepareBookContent returns a cloned canonical request so authorization and the
// upstream always see the same path. It never redirects an unauthorized route.
func (s *server) prepareBookContent(response http.ResponseWriter, request *http.Request) (*http.Request, bool) {
	value := request.URL.Path
	if !bookResponsePath(value) {
		return request, true
	}
	if routeWithin(value, "/books") {
		value = canonicalBookPath(value)
		switch value {
		case "/books/_access/":
			if request.Method == http.MethodGet || request.Method == http.MethodHead {
				s.serveBookAccess(response, true)
			} else {
				s.serveBookAccess(response, false)
			}
			return request, false
		case "/books/":
			if s.hasBookOwnerAccess(request) {
				value = "/books/_owner/"
			}
		case "/books/_owner/":
			if !s.hasBookOwnerAccess(request) {
				s.serveBookAccess(response, false)
				return request, false
			}
		default:
			if s.catalog == nil || !s.catalog.ContainsBookContentPath(value) ||
				(s.isProtectedBookContent(value) && !s.hasBookPathAccess(request, value)) {
				s.serveBookAccess(response, false)
				return request, false
			}
			s.promoteLegacyBookShares(response, request, value)
		}
	} else if routeWithin(value, "/images/books") {
		parts := strings.Split(strings.TrimPrefix(value, "/images/books/"), "/")
		if len(parts) < 2 || parts[len(parts)-1] == "" || s.catalog == nil || !s.catalog.ContainsBook(parts[0]) {
			s.serveBookAccess(response, false)
			return request, false
		}
		if _, private := s.privateBookSlugs[parts[0]]; private {
			if !s.hasBookImageAccess(request, parts[0]) {
				s.serveBookAccess(response, false)
				return request, false
			}
		}
	}
	request = request.Clone(request.Context())
	request.URL.Path = value
	request.URL.RawPath = ""
	return request, true
}

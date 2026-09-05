package httpserver

import (
	"context"
	"net/http"
	"strings"
)

type postRoutingKey struct{}

type postRouting struct {
	path    string
	private bool
}

func postIndexPath(value string) bool {
	return value == "/" || value == "/index.html" || routeWithin(value, "/archive") || routeWithin(value, "/tags")
}

func (s *server) isProtectedPostContent(value string) bool {
	if !strings.HasPrefix(value, "/posts/") || !strings.HasSuffix(value, "/") {
		return false
	}
	slug := strings.TrimSuffix(strings.TrimPrefix(value, "/posts/"), "/")
	_, private := s.privatePostSlugs[slug]
	return private
}

func (s *server) isProtectedContent(value string) bool {
	return s.isProtectedBookContent(value) || s.isProtectedPostContent(value)
}

func (s *server) containsContentPath(value string) bool {
	if s.catalog == nil {
		return false
	}
	if s.catalog.ContainsBookContentPath(value) {
		return true
	}
	_, ok := s.catalog.SlugFromPath(value)
	return ok
}

func (s *server) preparePostContent(response http.ResponseWriter, request *http.Request) (*http.Request, bool) {
	value := request.URL.Path
	if canonicalBookPath(value) == "/_access/" {
		s.serveBookAccess(response, request.Method == http.MethodGet || request.Method == http.MethodHead)
		return request, false
	}

	upstreamPath := value
	private := false
	switch {
	case postIndexPath(value):
		value = canonicalBookPath(value)
		upstreamPath = value
		if s.hasBookOwnerAccess(request) {
			upstreamPath = "/_owner" + value
			private = true
		}
	case routeWithin(value, "/posts"):
		value = canonicalBookPath(value)
		upstreamPath = value
		if !s.containsContentPath(value) {
			s.serveBookAccess(response, false)
			return request, false
		}
		private = s.isProtectedPostContent(value)
		if private {
			if !s.hasBookPathAccess(request, value) {
				s.serveBookAccess(response, false)
				return request, false
			}
			upstreamPath = "/_content" + value
		}
	default:
		owners, protected := s.privatePostAssets[value]
		if !protected {
			return request, true
		}
		allowed := s.hasBookOwnerAccess(request)
		for _, slug := range owners {
			if s.hasBookPathAccess(request, "/posts/"+slug+"/") {
				allowed = true
				break
			}
		}
		if !allowed {
			s.serveBookAccess(response, false)
			return request, false
		}
		private = true
		upstreamPath = "/_content/assets" + value
	}
	request = request.Clone(context.WithValue(request.Context(), postRoutingKey{}, postRouting{path: value, private: private}))
	request.URL.Path = upstreamPath
	request.URL.RawPath = ""
	return request, true
}

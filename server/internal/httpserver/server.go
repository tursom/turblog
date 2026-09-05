package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/catalog"
	"github.com/tursom/turblog/server/internal/clientkind"
)

const (
	maxRequestBody = 16 * 1024
	maxSubjectIDs  = 100
)

type Config struct {
	Analytics          *analytics.Tracker
	PrivateBookSlugs   []string
	PrivatePostSlugs   []string
	PrivatePostAssets  map[string][]string
	BookAccessPassword []byte
	Catalog            *catalog.Catalog
	ContentUpstream    *url.URL
	Logger             *slog.Logger
	Now                func() time.Time
	TrustProxyHeaders  bool
}

type server struct {
	analytics         *analytics.Tracker
	privateBookSlugs  map[string]struct{}
	privatePostSlugs  map[string]struct{}
	privatePostAssets map[string][]string
	bookAccessKey     []byte
	catalog           *catalog.Catalog
	logger            *slog.Logger
	now               func() time.Time
	proxy             *httputil.ReverseProxy
	trustProxyHeaders bool
}

func New(config Config) http.Handler {
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	application := &server{
		analytics:         config.Analytics,
		privateBookSlugs:  make(map[string]struct{}, len(config.PrivateBookSlugs)),
		privatePostSlugs:  make(map[string]struct{}, len(config.PrivatePostSlugs)),
		privatePostAssets: config.PrivatePostAssets,
		bookAccessKey:     deriveBookAccessKey(config.BookAccessPassword),
		catalog:           config.Catalog,
		logger:            config.Logger,
		now:               config.Now,
		trustProxyHeaders: config.TrustProxyHeaders,
	}
	for _, slug := range config.PrivateBookSlugs {
		application.privateBookSlugs[slug] = struct{}{}
	}
	for _, slug := range config.PrivatePostSlugs {
		application.privatePostSlugs[slug] = struct{}{}
	}
	if config.ContentUpstream != nil {
		application.proxy = httputil.NewSingleHostReverseProxy(config.ContentUpstream)
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		application.proxy.Transport = transport
		application.proxy.ErrorHandler = application.proxyError
		application.proxy.ModifyResponse = application.recordArticleView
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", application.health)
	mux.HandleFunc("POST /api/v1/analytics/metrics/query", application.queryMetrics)
	mux.HandleFunc("POST /api/v1/books/access", application.grantBookAccess)
	mux.HandleFunc("POST /books/_access/share", application.createBookShareToken)
	mux.HandleFunc("/api/v1/", notFound)
	mux.HandleFunc("/", application.proxyContent)
	return application.privacyGuard(mux)
}

func (s *server) health(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 500*time.Millisecond)
	defer cancel()
	if err := s.analytics.Ping(ctx); err != nil {
		s.logger.Error("health check analytics storage", "error", err)
		writeError(response, http.StatusServiceUnavailable, "storage_unavailable", "analytics storage is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

type metricQuery struct {
	Metric      string   `json:"metric"`
	SubjectType string   `json:"subject_type"`
	SubjectIDs  []string `json:"subject_ids"`
}

type metricResponse struct {
	Metric  string           `json:"metric"`
	Values  map[string]int64 `json:"values"`
	Unknown []string         `json:"unknown"`
}

func (s *server) queryMetrics(response http.ResponseWriter, request *http.Request) {
	bookPrivacyHeaders(response.Header())
	if mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var query metricQuery
	if err := decoder.Decode(&query); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "request body must be valid JSON")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "request body must contain one JSON object")
		return
	}
	if query.Metric != analytics.ArticleUniqueViewsMetric && query.Metric != analytics.BookChapterUniqueViewsMetric {
		writeError(response, http.StatusBadRequest, "unsupported_metric", "unsupported metric or subject type")
		return
	}
	if (query.Metric == analytics.ArticleUniqueViewsMetric && query.SubjectType != analytics.ArticleSubjectType) ||
		(query.Metric == analytics.BookChapterUniqueViewsMetric && query.SubjectType != analytics.BookChapterSubjectType) {
		writeError(response, http.StatusBadRequest, "unsupported_metric", "unsupported metric or subject type")
		return
	}
	if len(query.SubjectIDs) == 0 || len(query.SubjectIDs) > maxSubjectIDs {
		writeError(response, http.StatusBadRequest, "invalid_subjects", "subject_ids must contain between 1 and 100 values")
		return
	}

	var counts analytics.CountResult
	var err error
	if query.SubjectType == analytics.ArticleSubjectType {
		allowed := make([]string, 0, len(query.SubjectIDs))
		hidden := make(map[string]struct{})
		for _, id := range query.SubjectIDs {
			path := "/posts/" + id + "/"
			if s.isProtectedPostContent(path) && !s.hasBookPathAccess(request, path) {
				hidden[id] = struct{}{}
				continue
			}
			allowed = append(allowed, id)
		}
		counts, err = s.analytics.ArticleViewCounts(request.Context(), allowed)
		for id := range hidden {
			counts.Unknown = append(counts.Unknown, id)
		}
		sort.Strings(counts.Unknown)
	} else {
		allowed := make([]string, 0, len(query.SubjectIDs))
		hidden := make(map[string]struct{})
		for _, id := range query.SubjectIDs {
			path := "/books/" + id + "/"
			known := false
			if s.catalog != nil {
				_, known = s.catalog.BookChapterIDFromPath(path)
			}
			if !known || (s.isProtectedBookContent(path) && !s.hasBookPathAccess(request, path)) {
				hidden[id] = struct{}{}
				continue
			}
			allowed = append(allowed, id)
		}
		counts, err = s.analytics.BookChapterViewCounts(request.Context(), allowed)
		for id := range hidden {
			counts.Unknown = append(counts.Unknown, id)
		}
		sort.Strings(counts.Unknown)
	}
	if err != nil {
		s.logger.Error("query content view counts", "subject_type", query.SubjectType, "error", err)
		writeError(response, http.StatusInternalServerError, "internal_error", "unable to query metrics")
		return
	}
	writeJSON(response, http.StatusOK, metricResponse{
		Metric:  query.Metric,
		Values:  counts.Values,
		Unknown: counts.Unknown,
	})
}

func (s *server) proxyContent(response http.ResponseWriter, request *http.Request) {
	var allowed bool
	request, allowed = s.preparePostContent(response, request)
	if !allowed {
		return
	}
	request, allowed = s.prepareBookContent(response, request)
	if !allowed {
		return
	}
	if s.proxy == nil {
		bookPrivacyHeaders(response.Header())
		writeError(response, http.StatusServiceUnavailable, "content_unavailable", "content upstream is unavailable")
		return
	}
	s.proxy.ServeHTTP(response, request)
}

func (s *server) isProtectedBookContent(path string) bool {
	bookSlug, isBookContent := catalog.BookSlugFromContentPath(path)
	if !isBookContent {
		return false
	}
	_, protected := s.privateBookSlugs[bookSlug]
	return protected
}

func (s *server) recordArticleView(upstreamResponse *http.Response) error {
	request := upstreamResponse.Request
	canonicalPath := request.URL.Path
	routing, routed := request.Context().Value(postRoutingKey{}).(postRouting)
	if routed {
		canonicalPath = routing.path
	}
	if strings.HasPrefix(canonicalPath, "/posts/") {
		upstreamResponse.Header.Set("Cache-Control", "private, no-cache, must-revalidate")
	}
	if bookResponsePath(canonicalPath) || routed && (routing.private || postIndexPath(canonicalPath)) {
		bookPrivacyHeaders(upstreamResponse.Header)
	}
	if upstreamResponse.StatusCode == http.StatusNotFound {
		page, err := s.bookAccessResponse(false)
		if err != nil {
			return err
		}
		_ = upstreamResponse.Body.Close()
		upstreamResponse.Header = page.Header
		upstreamResponse.Body = page.Body
		upstreamResponse.ContentLength = page.ContentLength
	}
	private := s.isProtectedBookContent(canonicalPath) || canonicalPath == "/books/_owner/" || routing.private
	if strings.HasPrefix(request.URL.Path, "/images/books/") {
		slug := strings.Split(strings.TrimPrefix(request.URL.Path, "/images/books/"), "/")[0]
		_, private = s.privateBookSlugs[slug]
	}
	if private {
		upstreamResponse.Header.Set("Referrer-Policy", "no-referrer")
		upstreamResponse.Header.Set("X-Robots-Tag", "noindex, noarchive")
	}
	if request.Method != http.MethodGet || upstreamResponse.StatusCode != http.StatusOK {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(upstreamResponse.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/html" {
		return nil
	}
	slug, isArticle := s.catalog.SlugFromPath(canonicalPath)
	bookChapterID, isBookChapter := s.catalog.BookChapterIDFromPath(canonicalPath)
	if !isArticle && !isBookChapter {
		return nil
	}

	clientIP := clientAddress(request, s.trustProxyHeaders)
	classifiedRequest := request.Clone(request.Context())
	classifiedRequest.RemoteAddr = clientIP
	view := analytics.ArticleView{
		Slug:       slug,
		ClientIP:   clientIP,
		UserAgent:  request.UserAgent(),
		ClientKind: clientkind.Classify(classifiedRequest),
		Referrer:   request.Referer(),
		OccurredAt: s.now(),
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 100*time.Millisecond)
	defer cancel()
	if isArticle {
		if _, err := s.analytics.RecordArticleView(ctx, view); err != nil {
			s.logger.Error("record article view", "slug", slug, "client_kind", view.ClientKind, "error", err)
		}
	} else {
		view.Slug = bookChapterID
		if _, err := s.analytics.RecordBookChapterView(ctx, view); err != nil {
			s.logger.Error("record book chapter view", "slug", bookChapterID, "client_kind", view.ClientKind, "error", err)
		}
	}
	return nil
}

func (s *server) proxyError(response http.ResponseWriter, _ *http.Request, err error) {
	bookPrivacyHeaders(response.Header())
	s.logger.Error("proxy article", "error", err)
	writeError(response, http.StatusBadGateway, "content_upstream_error", "content upstream request failed")
}

func clientAddress(request *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		candidate := strings.TrimSpace(request.Header.Get("X-Real-IP"))
		if parsed := net.ParseIP(candidate); parsed != nil {
			return parsed.String()
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		if parsed := net.ParseIP(host); parsed != nil {
			return parsed.String()
		}
	}
	return request.RemoteAddr
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("trailing JSON value")
	}
	return err
}

func notFound(response http.ResponseWriter, _ *http.Request) {
	writeError(response, http.StatusNotFound, "not_found", "route not found")
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

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
	BookAccessPassword []byte
	Catalog            *catalog.Catalog
	ContentUpstream    *url.URL
	Logger             *slog.Logger
	Now                func() time.Time
	TrustProxyHeaders  bool
}

type server struct {
	analytics          *analytics.Tracker
	bookAccessPassword []byte
	catalog            *catalog.Catalog
	logger             *slog.Logger
	now                func() time.Time
	proxy              *httputil.ReverseProxy
	trustProxyHeaders  bool
}

func New(config Config) http.Handler {
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	application := &server{
		analytics:          config.Analytics,
		bookAccessPassword: config.BookAccessPassword,
		catalog:            config.Catalog,
		logger:             config.Logger,
		now:                config.Now,
		trustProxyHeaders:  config.TrustProxyHeaders,
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
	mux.HandleFunc("/api/v1/", notFound)
	mux.HandleFunc("/", application.proxyContent)
	return mux
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
		counts, err = s.analytics.ArticleViewCounts(request.Context(), query.SubjectIDs)
	} else {
		counts, err = s.analytics.BookChapterViewCounts(request.Context(), query.SubjectIDs)
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
	if s.proxy == nil {
		writeError(response, http.StatusServiceUnavailable, "content_unavailable", "content upstream is unavailable")
		return
	}
	if catalog.IsBookChapterPath(request.URL.Path) && !s.hasBookAccess(request) {
		s.serveBookAccess(response)
		return
	}
	s.proxy.ServeHTTP(response, request)
}

func (s *server) recordArticleView(upstreamResponse *http.Response) error {
	request := upstreamResponse.Request
	if strings.HasPrefix(request.URL.Path, "/posts/") || strings.HasPrefix(request.URL.Path, "/books/") {
		upstreamResponse.Header.Set("Cache-Control", "private, no-cache, must-revalidate")
	}
	if catalog.IsBookChapterPath(request.URL.Path) {
		upstreamResponse.Header.Set("Referrer-Policy", "no-referrer")
		upstreamResponse.Header.Add("Vary", "Cookie")
	}
	if request.Method != http.MethodGet || upstreamResponse.StatusCode != http.StatusOK {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(upstreamResponse.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/html" {
		return nil
	}
	slug, isArticle := s.catalog.SlugFromPath(request.URL.Path)
	bookChapterID, isBookChapter := s.catalog.BookChapterIDFromPath(request.URL.Path)
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

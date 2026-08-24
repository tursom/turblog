package analytics

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	ArticleSubjectType           = "article"
	ArticleUniqueViewsMetric     = "article_unique_views"
	BookChapterSubjectType       = "book_chapter"
	BookChapterUniqueViewsMetric = "book_chapter_unique_views"
	articleViewEvent             = "article_view"
)

type ClientKind string

const (
	ClientBrowser    ClientKind = "browser"
	ClientCrawler    ClientKind = "crawler"
	ClientAutomation ClientKind = "automation"
	ClientUnknown    ClientKind = "unknown"
)

var ErrUnknownArticle = errors.New("unknown article")
var ErrUnknownBookChapter = errors.New("unknown book chapter")

type Config struct {
	DatabasePath   string
	HashKey        []byte
	Location       *time.Location
	ArticleSlugs   []string
	BookChapterIDs []string
}

type ArticleView struct {
	Slug       string
	ClientIP   string
	UserAgent  string
	ClientKind ClientKind
	Referrer   string
	OccurredAt time.Time
}

type BookChapterView = ArticleView

type RecordResult struct {
	Count   int64
	Counted bool
}

type CountResult struct {
	Values  map[string]int64
	Unknown []string
}

type Tracker struct {
	db           *sql.DB
	hashKey      []byte
	location     *time.Location
	articles     map[string]struct{}
	bookChapters map[string]struct{}
}

func Open(ctx context.Context, config Config) (*Tracker, error) {
	if config.DatabasePath == "" {
		return nil, errors.New("database path is required")
	}
	if len(config.HashKey) < 32 {
		return nil, errors.New("hash key must contain at least 32 bytes")
	}
	if config.Location == nil {
		return nil, errors.New("location is required")
	}
	if err := ensureDirectory(config.DatabasePath); err != nil {
		return nil, err
	}

	dsn := "file:" + filepath.ToSlash(config.DatabasePath) +
		"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open analytics database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping analytics database: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}

	articles := make(map[string]struct{}, len(config.ArticleSlugs))
	for _, slug := range config.ArticleSlugs {
		articles[slug] = struct{}{}
	}
	bookChapters := make(map[string]struct{}, len(config.BookChapterIDs))
	for _, id := range config.BookChapterIDs {
		bookChapters[id] = struct{}{}
	}
	return &Tracker{
		db:           db,
		hashKey:      append([]byte(nil), config.HashKey...),
		location:     config.Location,
		articles:     articles,
		bookChapters: bookChapters,
	}, nil
}

func ensureDirectory(databasePath string) error {
	directory := filepath.Dir(databasePath)
	if directory == "." {
		return nil
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return fmt.Errorf("create analytics database directory: %w", err)
	}
	return nil
}

func (t *Tracker) Close() error {
	return t.db.Close()
}

func (t *Tracker) Ping(ctx context.Context) error {
	return t.db.PingContext(ctx)
}

func (t *Tracker) RecordArticleView(ctx context.Context, view ArticleView) (RecordResult, error) {
	return t.recordView(ctx, ArticleSubjectType, ArticleUniqueViewsMetric, t.articles, ErrUnknownArticle, view)
}

func (t *Tracker) RecordBookChapterView(ctx context.Context, view BookChapterView) (RecordResult, error) {
	return t.recordView(ctx, BookChapterSubjectType, BookChapterUniqueViewsMetric, t.bookChapters, ErrUnknownBookChapter, view)
}

func (t *Tracker) recordView(ctx context.Context, subjectType, metric string, known map[string]struct{}, unknown error, view ArticleView) (RecordResult, error) {
	if _, ok := known[view.Slug]; !ok {
		return RecordResult{}, unknown
	}
	if view.OccurredAt.IsZero() {
		return RecordResult{}, errors.New("occurred time is required")
	}
	if !view.ClientKind.valid() {
		return RecordResult{}, errors.New("invalid client kind")
	}

	day := view.OccurredAt.In(t.location).Format(time.DateOnly)
	dedupeKey := t.visitorHashForSubject(subjectType, day, view)
	transaction, err := t.db.BeginTx(ctx, nil)
	if err != nil {
		return RecordResult{}, fmt.Errorf("begin article view transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	insert, err := transaction.ExecContext(ctx, `
		INSERT OR IGNORE INTO analytics_events (
			event_type, subject_type, subject_id, occurred_at, day,
			visitor_hash, referrer_host, client_kind
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		articleViewEvent,
		subjectType,
		view.Slug,
		view.OccurredAt.UTC().UnixMilli(),
		day,
		dedupeKey,
		normalizeReferrerHost(view.Referrer),
		view.ClientKind,
	)
	if err != nil {
		return RecordResult{}, fmt.Errorf("insert article view event: %w", err)
	}
	rows, err := insert.RowsAffected()
	if err != nil {
		return RecordResult{}, fmt.Errorf("read article view insert result: %w", err)
	}
	counted := rows == 1
	if counted {
		_, err = transaction.ExecContext(ctx, `
			INSERT INTO analytics_metric_totals (
				metric, subject_type, subject_id, value, updated_at
			) VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(metric, subject_type, subject_id)
			DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`,
			metric,
			subjectType,
			view.Slug,
			view.OccurredAt.UTC().UnixMilli(),
		)
		if err != nil {
			return RecordResult{}, fmt.Errorf("update article view total: %w", err)
		}
	}

	var count int64
	err = transaction.QueryRowContext(ctx, `
		SELECT value
		FROM analytics_metric_totals
		WHERE metric = ? AND subject_type = ? AND subject_id = ?`,
		metric,
		subjectType,
		view.Slug,
	).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		count = 0
	} else if err != nil {
		return RecordResult{}, fmt.Errorf("read %s view total: %w", subjectType, err)
	}
	if err := transaction.Commit(); err != nil {
		return RecordResult{}, fmt.Errorf("commit article view transaction: %w", err)
	}
	return RecordResult{Count: count, Counted: counted}, nil
}

func (t *Tracker) ArticleViewCounts(ctx context.Context, slugs []string) (CountResult, error) {
	return t.viewCounts(ctx, ArticleUniqueViewsMetric, ArticleSubjectType, t.articles, slugs)
}

func (t *Tracker) BookChapterViewCounts(ctx context.Context, ids []string) (CountResult, error) {
	return t.viewCounts(ctx, BookChapterUniqueViewsMetric, BookChapterSubjectType, t.bookChapters, ids)
}

func (t *Tracker) viewCounts(ctx context.Context, metric, subjectType string, knownSubjects map[string]struct{}, slugs []string) (CountResult, error) {
	result := CountResult{
		Values:  make(map[string]int64, len(slugs)),
		Unknown: make([]string, 0),
	}
	known := make([]string, 0, len(slugs))
	seen := make(map[string]struct{}, len(slugs))
	for _, slug := range slugs {
		if _, duplicate := seen[slug]; duplicate {
			continue
		}
		seen[slug] = struct{}{}
		if _, ok := knownSubjects[slug]; !ok {
			result.Unknown = append(result.Unknown, slug)
			continue
		}
		result.Values[slug] = 0
		known = append(known, slug)
	}
	if len(known) == 0 {
		return result, nil
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(known)), ",")
	arguments := make([]any, 0, len(known)+2)
	arguments = append(arguments, metric, subjectType)
	for _, slug := range known {
		arguments = append(arguments, slug)
	}
	rows, err := t.db.QueryContext(ctx, `
		SELECT subject_id, value
		FROM analytics_metric_totals
		WHERE metric = ? AND subject_type = ? AND subject_id IN (`+placeholders+`)`,
		arguments...,
	)
	if err != nil {
		return CountResult{}, fmt.Errorf("query %s view totals: %w", subjectType, err)
	}
	defer rows.Close()
	for rows.Next() {
		var slug string
		var value int64
		if err := rows.Scan(&slug, &value); err != nil {
			return CountResult{}, fmt.Errorf("scan %s view total: %w", subjectType, err)
		}
		result.Values[slug] = value
	}
	if err := rows.Err(); err != nil {
		return CountResult{}, fmt.Errorf("iterate %s view totals: %w", subjectType, err)
	}
	sort.Strings(result.Unknown)
	return result, nil
}

func (t *Tracker) visitorHash(day string, view ArticleView) []byte {
	return t.visitorHashForSubject(ArticleSubjectType, day, view)
}

func (t *Tracker) visitorHashForSubject(subjectType, day string, view ArticleView) []byte {
	digest := hmac.New(sha256.New, t.hashKey)
	values := []string{day, view.Slug, view.ClientIP, view.UserAgent}
	if subjectType != ArticleSubjectType {
		values = append([]string{subjectType}, values...)
	}
	for _, value := range values {
		_, _ = digest.Write([]byte(value))
		_, _ = digest.Write([]byte{0})
	}
	return digest.Sum(nil)
}

func (kind ClientKind) valid() bool {
	switch kind {
	case ClientBrowser, ClientCrawler, ClientAutomation, ClientUnknown:
		return true
	default:
		return false
	}
}

func normalizeReferrerHost(referrer string) string {
	if referrer == "" {
		return ""
	}
	parsed, err := url.Parse(referrer)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

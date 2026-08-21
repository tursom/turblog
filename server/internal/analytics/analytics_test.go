package analytics_test

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/tursom/turblog/server/internal/analytics"
)

func TestRecordArticleViewDeduplicatesPerVisitorDay(t *testing.T) {
	t.Parallel()

	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	tracker, err := analytics.Open(context.Background(), analytics.Config{
		DatabasePath: filepath.Join(t.TempDir(), "turblog.sqlite"),
		HashKey:      []byte("0123456789abcdef0123456789abcdef"),
		Location:     location,
		ArticleSlugs: []string{"go-atomic-generics", "row-linked-list"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracker.Close() })

	first := analytics.ArticleView{
		Slug:       "go-atomic-generics",
		ClientIP:   "203.0.113.8",
		UserAgent:  "Example Browser",
		ClientKind: analytics.ClientBrowser,
		Referrer:   "https://search.example/results?q=go",
		OccurredAt: time.Date(2026, 8, 21, 9, 0, 0, 0, location),
	}

	result, err := tracker.RecordArticleView(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Counted || result.Count != 1 {
		t.Fatalf("first result = %+v, want counted with total 1", result)
	}

	result, err = tracker.RecordArticleView(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if result.Counted || result.Count != 1 {
		t.Fatalf("duplicate result = %+v, want not counted with total 1", result)
	}

	nextDay := first
	nextDay.OccurredAt = first.OccurredAt.Add(24 * time.Hour)
	result, err = tracker.RecordArticleView(context.Background(), nextDay)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Counted || result.Count != 2 {
		t.Fatalf("next-day result = %+v, want counted with total 2", result)
	}

	counts, err := tracker.ArticleViewCounts(
		context.Background(),
		[]string{"row-linked-list", "go-atomic-generics", "missing"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values["row-linked-list"] != 0 || counts.Values["go-atomic-generics"] != 2 {
		t.Fatalf("counts = %#v, want row-linked-list=0 and go-atomic-generics=2", counts.Values)
	}
	if len(counts.Unknown) != 1 || counts.Unknown[0] != "missing" {
		t.Fatalf("unknown = %#v, want [missing]", counts.Unknown)
	}
}

func TestRecordArticleViewIsAtomicUnderConcurrentDuplicates(t *testing.T) {
	t.Parallel()

	location := time.FixedZone("CST", 8*60*60)
	tracker, err := analytics.Open(context.Background(), analytics.Config{
		DatabasePath: filepath.Join(t.TempDir(), "turblog.sqlite"),
		HashKey:      []byte("0123456789abcdef0123456789abcdef"),
		Location:     location,
		ArticleSlugs: []string{"go-atomic-generics"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracker.Close() })

	view := analytics.ArticleView{
		Slug:       "go-atomic-generics",
		ClientIP:   "203.0.113.8",
		UserAgent:  "Example Browser",
		ClientKind: analytics.ClientBrowser,
		OccurredAt: time.Date(2026, 8, 21, 9, 0, 0, 0, location),
	}
	const workers = 20
	var wait sync.WaitGroup
	errors := make(chan error, workers)
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := tracker.RecordArticleView(context.Background(), view)
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}

	counts, err := tracker.ArticleViewCounts(context.Background(), []string{view.Slug})
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values[view.Slug] != 1 {
		t.Fatalf("view count = %d, want 1", counts.Values[view.Slug])
	}
}

func TestAllClientKindsAndArticlesContributeToTotals(t *testing.T) {
	t.Parallel()

	location := time.FixedZone("CST", 8*60*60)
	tracker, err := analytics.Open(context.Background(), analytics.Config{
		DatabasePath: filepath.Join(t.TempDir(), "turblog.sqlite"),
		HashKey:      []byte("0123456789abcdef0123456789abcdef"),
		Location:     location,
		ArticleSlugs: []string{"go-atomic-generics", "row-linked-list"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracker.Close() })

	kinds := []analytics.ClientKind{
		analytics.ClientBrowser,
		analytics.ClientCrawler,
		analytics.ClientAutomation,
		analytics.ClientUnknown,
	}
	for index, kind := range kinds {
		_, err := tracker.RecordArticleView(context.Background(), analytics.ArticleView{
			Slug:       "go-atomic-generics",
			ClientIP:   "203.0.113." + string(rune('1'+index)),
			UserAgent:  string(kind),
			ClientKind: kind,
			OccurredAt: time.Date(2026, 8, 21, 9, index, 0, 0, location),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = tracker.RecordArticleView(context.Background(), analytics.ArticleView{
		Slug:       "row-linked-list",
		ClientIP:   "198.51.100.8",
		UserAgent:  "browser",
		ClientKind: analytics.ClientBrowser,
		OccurredAt: time.Date(2026, 8, 21, 10, 0, 0, 0, location),
	})
	if err != nil {
		t.Fatal(err)
	}

	counts, err := tracker.ArticleViewCounts(
		context.Background(),
		[]string{"go-atomic-generics", "row-linked-list"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values["go-atomic-generics"] != 4 || counts.Values["row-linked-list"] != 1 {
		t.Fatalf("counts = %#v, want go-atomic-generics=4 and row-linked-list=1", counts.Values)
	}
}

func TestTrackerPersistsCountsAcrossRestart(t *testing.T) {
	t.Parallel()

	databasePath := filepath.Join(t.TempDir(), "turblog.sqlite")
	config := analytics.Config{
		DatabasePath: databasePath,
		HashKey:      []byte("0123456789abcdef0123456789abcdef"),
		Location:     time.FixedZone("CST", 8*60*60),
		ArticleSlugs: []string{"go-atomic-generics"},
	}
	tracker, err := analytics.Open(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tracker.RecordArticleView(context.Background(), analytics.ArticleView{
		Slug:       "go-atomic-generics",
		ClientIP:   "203.0.113.8",
		UserAgent:  "Example Browser",
		ClientKind: analytics.ClientBrowser,
		OccurredAt: time.Date(2026, 8, 21, 9, 0, 0, 0, config.Location),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tracker.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, err := analytics.Open(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	counts, err := restarted.ArticleViewCounts(context.Background(), []string{"go-atomic-generics"})
	if err != nil {
		t.Fatal(err)
	}
	if counts.Values["go-atomic-generics"] != 1 {
		t.Fatalf("persisted count = %d, want 1", counts.Values["go-atomic-generics"])
	}
}

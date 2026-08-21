package analytics

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigrateCreatesCurrentSchemaAndIsIdempotent(t *testing.T) {
	t.Parallel()

	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "analytics.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	for range 2 {
		if err := migrate(context.Background(), database); err != nil {
			t.Fatal(err)
		}
	}
	var version int
	if err := database.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != latestSchemaVersion {
		t.Fatalf("schema version = %d, want %d", version, latestSchemaVersion)
	}
	for _, table := range []string{"analytics_events", "analytics_metric_totals"} {
		var count int
		if err := database.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,
			table,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("table %q count = %d, want 1", table, count)
		}
	}
}

func TestMigrateRejectsNewerSchema(t *testing.T) {
	t.Parallel()

	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "future.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.Exec(`PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(context.Background(), database); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("migrate() error = %v, want newer schema error", err)
	}
}

func TestNormalizeReferrerHost(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"":          "",
		"not a URL": "",
		"https://Search.Example:8443/results?q=x": "search.example",
		"https://xn--fsqu00a.xn--0zwm56d/path":    "xn--fsqu00a.xn--0zwm56d",
	}
	for input, want := range tests {
		if got := normalizeReferrerHost(input); got != want {
			t.Errorf("normalizeReferrerHost(%q) = %q, want %q", input, got, want)
		}
	}
}

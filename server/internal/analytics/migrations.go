package analytics

import (
	"context"
	"database/sql"
	"fmt"
)

const latestSchemaVersion = 1

var migrations = [][]string{
	{
		`CREATE TABLE analytics_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_type TEXT NOT NULL,
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL,
			occurred_at INTEGER NOT NULL,
			day TEXT NOT NULL,
			visitor_hash BLOB NOT NULL,
			referrer_host TEXT NOT NULL,
			client_kind TEXT NOT NULL,
			UNIQUE(event_type, subject_type, subject_id, day, visitor_hash)
		)`,
		`CREATE INDEX analytics_events_subject_time
			ON analytics_events(event_type, subject_type, subject_id, occurred_at)`,
		`CREATE INDEX analytics_events_dimensions
			ON analytics_events(event_type, day, referrer_host, client_kind)`,
		`CREATE TABLE analytics_metric_totals (
			metric TEXT NOT NULL,
			subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL,
			value INTEGER NOT NULL CHECK(value >= 0),
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(metric, subject_type, subject_id)
		)`,
	},
}

func migrate(ctx context.Context, db *sql.DB) error {
	var currentVersion int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&currentVersion); err != nil {
		return fmt.Errorf("read analytics schema version: %w", err)
	}
	if currentVersion > latestSchemaVersion {
		return fmt.Errorf(
			"analytics schema version %d is newer than supported version %d",
			currentVersion,
			latestSchemaVersion,
		)
	}

	for currentVersion < latestSchemaVersion {
		nextVersion := currentVersion + 1
		transaction, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin analytics migration %d: %w", nextVersion, err)
		}
		for _, statement := range migrations[currentVersion] {
			if _, err := transaction.ExecContext(ctx, statement); err != nil {
				_ = transaction.Rollback()
				return fmt.Errorf("run analytics migration %d: %w", nextVersion, err)
			}
		}
		if _, err := transaction.ExecContext(
			ctx,
			fmt.Sprintf("PRAGMA user_version = %d", nextVersion),
		); err != nil {
			_ = transaction.Rollback()
			return fmt.Errorf("set analytics schema version %d: %w", nextVersion, err)
		}
		if err := transaction.Commit(); err != nil {
			return fmt.Errorf("commit analytics migration %d: %w", nextVersion, err)
		}
		currentVersion = nextVersion
	}
	return nil
}

package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/catalog"
	"github.com/tursom/turblog/server/internal/config"
	"github.com/tursom/turblog/server/internal/httpserver"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, logger); err != nil {
		logger.Error("turblog server stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, logger *slog.Logger) error {
	settings, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	articles, err := catalog.Load(settings.SitemapPath)
	if err != nil {
		return err
	}
	tracker, err := analytics.Open(ctx, analytics.Config{
		DatabasePath:   settings.DatabasePath,
		HashKey:        settings.HashKey,
		Location:       settings.Location,
		ArticleSlugs:   articles.Slugs(),
		BookChapterIDs: articles.BookChapterIDs(),
	})
	if err != nil {
		return err
	}
	defer tracker.Close()

	handler := httpserver.New(httpserver.Config{
		Analytics:          tracker,
		BookAccessPassword: settings.BookAccessPassword,
		Catalog:            articles,
		ContentUpstream:    settings.ContentUpstream,
		Logger:             logger,
		TrustProxyHeaders:  settings.TrustProxyHeaders,
	})
	server := &http.Server{
		Addr:              settings.ListenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("turblog server listening", "address", settings.ListenAddress, "articles", len(articles.Slugs()))
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return err
		}
		return nil
	}
}

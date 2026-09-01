package config

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

type Values struct {
	ListenAddress      string
	DatabasePath       string
	SitemapPath        string
	ContentUpstream    *url.URL
	BookAccessPassword []byte
	HashKey            []byte
	Location           *time.Location
	TrustProxyHeaders  bool
}

func Load(getenv func(string) string) (Values, error) {
	hashKey := []byte(getenv("TURBLOG_VISITOR_HASH_KEY"))
	if len(hashKey) < 32 {
		return Values{}, errors.New("TURBLOG_VISITOR_HASH_KEY must contain at least 32 bytes")
	}
	bookAccessPassword := []byte(getenv("TURBLOG_BOOK_ACCESS_PASSWORD"))
	if len(bookAccessPassword) < 32 {
		return Values{}, errors.New("TURBLOG_BOOK_ACCESS_PASSWORD must contain at least 32 bytes")
	}
	locationName := valueOrDefault(getenv("TURBLOG_TIMEZONE"), "Asia/Shanghai")
	location, err := time.LoadLocation(locationName)
	if err != nil {
		return Values{}, fmt.Errorf("load TURBLOG_TIMEZONE: %w", err)
	}
	upstreamValue := valueOrDefault(getenv("TURBLOG_CONTENT_UPSTREAM"), "http://blog:8080")
	upstream, err := url.Parse(upstreamValue)
	if err != nil || upstream.Host == "" || (upstream.Scheme != "http" && upstream.Scheme != "https") {
		return Values{}, errors.New("TURBLOG_CONTENT_UPSTREAM must be an absolute HTTP URL")
	}
	trustProxyHeaders := false
	if value := getenv("TURBLOG_TRUST_PROXY_HEADERS"); value != "" {
		trustProxyHeaders, err = strconv.ParseBool(value)
		if err != nil {
			return Values{}, errors.New("TURBLOG_TRUST_PROXY_HEADERS must be true or false")
		}
	}
	return Values{
		ListenAddress:      valueOrDefault(getenv("TURBLOG_LISTEN_ADDR"), ":8080"),
		DatabasePath:       valueOrDefault(getenv("TURBLOG_DB_PATH"), "/var/lib/turblog/server.sqlite"),
		SitemapPath:        valueOrDefault(getenv("TURBLOG_SITEMAP_PATH"), "/usr/share/nginx/html/sitemap-0.xml"),
		ContentUpstream:    upstream,
		BookAccessPassword: bookAccessPassword,
		HashKey:            hashKey,
		Location:           location,
		TrustProxyHeaders:  trustProxyHeaders,
	}, nil
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

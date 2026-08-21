package clientkind_test

import (
	"net/http/httptest"
	"testing"

	"github.com/tursom/turblog/server/internal/analytics"
	"github.com/tursom/turblog/server/internal/clientkind"
)

func TestClassify(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		userAgent string
		want      analytics.ClientKind
	}{
		{
			name:      "browser",
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
			want:      analytics.ClientBrowser,
		},
		{
			name:      "search crawler",
			userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
			want:      analytics.ClientCrawler,
		},
		{
			name:      "link preview crawler",
			userAgent: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
			want:      analytics.ClientCrawler,
		},
		{name: "curl", userAgent: "curl/8.14.1", want: analytics.ClientAutomation},
		{name: "wget", userAgent: "Wget/1.25.0", want: analytics.ClientAutomation},
		{name: "python", userAgent: "python-requests/2.32.4", want: analytics.ClientAutomation},
		{name: "go sdk", userAgent: "Go-http-client/1.1", want: analytics.ClientAutomation},
		{name: "java sdk", userAgent: "Java/25", want: analytics.ClientAutomation},
		{
			name:      "playwright",
			userAgent: "Mozilla/5.0 Playwright/1.62 Chrome/140.0.0.0 Safari/537.36",
			want:      analytics.ClientAutomation,
		},
		{
			name:      "selenium",
			userAgent: "Mozilla/5.0 Selenium/4.35 Chrome/140.0.0.0 Safari/537.36",
			want:      analytics.ClientAutomation,
		},
		{
			name:      "headless browser",
			userAgent: "Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/140.0.0.0 Safari/537.36",
			want:      analytics.ClientAutomation,
		},
		{name: "empty user agent", userAgent: "", want: analytics.ClientUnknown},
		{
			name:      "unrecognized client",
			userAgent: "CustomClient/1.0 running locally",
			want:      analytics.ClientUnknown,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest("GET", "https://blog.tursom.dev/posts/example/", nil)
			request.Header.Set("User-Agent", tt.userAgent)
			if got := clientkind.Classify(request); got != tt.want {
				t.Fatalf("Classify() = %q, want %q", got, tt.want)
			}
		})
	}
}

package clientkind

import (
	"net/http"
	"strings"

	"github.com/tursom/turblog/server/internal/analytics"
	"zgo.at/isbot"
)

var automationMarkers = []string{
	"axios/",
	"curl/",
	"go-http-client/",
	"headlesschrome/",
	"java/",
	"libwww-perl/",
	"node-fetch/",
	"okhttp/",
	"playwright/",
	"postmanruntime/",
	"python-requests/",
	"selenium/",
	"wget/",
}

var browserMarkers = []string{
	"chrome/",
	"chromium/",
	"crios/",
	"edg/",
	"firefox/",
	"fxios/",
	"opr/",
	"safari/",
}

func Classify(request *http.Request) analytics.ClientKind {
	userAgent := strings.ToLower(request.UserAgent())
	if userAgent == "" {
		return analytics.ClientUnknown
	}
	if containsAny(userAgent, automationMarkers) {
		return analytics.ClientAutomation
	}
	bot := isbot.Bot(request)
	if bot == isbot.BotClientLibrary || bot == isbot.BotPrefetch || bot >= isbot.BotJSPhanton {
		return analytics.ClientAutomation
	}
	if isbot.Is(bot) {
		return analytics.ClientCrawler
	}
	if strings.Contains(userAgent, "mozilla/") && containsAny(userAgent, browserMarkers) {
		return analytics.ClientBrowser
	}
	return analytics.ClientUnknown
}

func containsAny(value string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

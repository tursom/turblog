package httpserver

import (
	"net/http/httptest"
	"testing"
)

func TestClientAddressUsesCanonicalRealIPFromTrustedProxy(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "[2001:db8::4]:4321"
	request.Header.Set("X-Real-IP", "2001:0db8:0:0:0:0:0:1")
	request.Header.Set("X-Forwarded-For", "2001:0db8:0:0:0:0:0:2, 192.0.2.1")
	request.Header.Set("CF-Connecting-IP", "2001:0db8:0:0:0:0:0:3")

	if got := clientAddress(request, true); got != "2001:db8::1" {
		t.Fatalf("clientAddress() = %q, want canonical trusted proxy address", got)
	}
}

func TestClientAddressIgnoresHeadersWithoutTrustedProxy(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "[2001:0db8:0:0:0:0:0:4]:4321"
	request.Header.Set("X-Real-IP", "2001:db8::1")
	request.Header.Set("CF-Connecting-IP", "2001:db8::2")
	request.Header.Set("X-Forwarded-For", "2001:db8::3")

	if got := clientAddress(request, false); got != "2001:db8::4" {
		t.Fatalf("clientAddress() = %q, want canonical remote address", got)
	}
}

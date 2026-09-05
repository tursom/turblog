package catalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PostAccessManifest maps original public asset URLs to the private posts that may access them.
// Files are served by the trusted content upstream under /_content/assets plus that URL path.
type PostAccessManifest struct {
	PrivatePosts  []string
	PrivateAssets map[string][]string
}

var postAssetExtension = regexp.MustCompile(`(?i)\.(avif|gif|ico|jpe?g|png|svg|webp|mp4|webm|mp3|ogg|wav|pdf|zip|gz|txt|csv|epub)$`)

func LoadPostAccessManifest(filename string) (PostAccessManifest, error) {
	contents, err := os.ReadFile(filename)
	if err != nil {
		return PostAccessManifest{}, fmt.Errorf("read post access manifest: %w", err)
	}
	if !utf8.Valid(contents) {
		return PostAccessManifest{}, errors.New("post access manifest is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	if err := rejectDuplicateJSONKeys(decoder); err != nil {
		return PostAccessManifest{}, fmt.Errorf("parse post access manifest: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return PostAccessManifest{}, fmt.Errorf("parse post access manifest: %w", err)
	}
	// Decode exact keys through a map: encoding/json struct matching is case-insensitive.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(contents, &fields); err != nil {
		return PostAccessManifest{}, fmt.Errorf("parse post access manifest: %w", err)
	}
	if len(fields) != 3 || fields["version"] == nil || fields["privatePosts"] == nil || fields["privateAssets"] == nil {
		return PostAccessManifest{}, errors.New("post access manifest requires exactly version, privatePosts and privateAssets")
	}
	var version int
	var manifest PostAccessManifest
	if err := json.Unmarshal(fields["version"], &version); err != nil || version != 1 {
		return PostAccessManifest{}, errors.New("post access manifest version must be 1")
	}
	if err := json.Unmarshal(fields["privatePosts"], &manifest.PrivatePosts); err != nil || manifest.PrivatePosts == nil {
		return PostAccessManifest{}, errors.New("post access manifest privatePosts must be an array of slugs")
	}
	if err := json.Unmarshal(fields["privateAssets"], &manifest.PrivateAssets); err != nil || manifest.PrivateAssets == nil {
		return PostAccessManifest{}, errors.New("post access manifest privateAssets must be an object of owner arrays")
	}
	seen := make(map[string]bool, len(manifest.PrivatePosts))
	for _, slug := range manifest.PrivatePosts {
		if !bookSlugPattern.MatchString(slug) || seen[slug] {
			return PostAccessManifest{}, fmt.Errorf("post access manifest contains invalid or duplicate post slug %q", slug)
		}
		seen[slug] = true
	}
	for asset, owners := range manifest.PrivateAssets {
		if !validPostAssetPath(asset) {
			return PostAccessManifest{}, fmt.Errorf("post access manifest contains invalid asset path %q", asset)
		}
		if len(owners) == 0 {
			return PostAccessManifest{}, fmt.Errorf("post access manifest asset %q has no owners", asset)
		}
		assetOwners := make(map[string]bool, len(owners))
		for _, slug := range owners {
			if !seen[slug] || assetOwners[slug] {
				return PostAccessManifest{}, fmt.Errorf("post access manifest asset %q has unknown or duplicate owner %q", asset, slug)
			}
			assetOwners[slug] = true
		}
		sort.Strings(owners)
	}
	sort.Strings(manifest.PrivatePosts)
	return manifest, nil
}

func validPostAssetPath(asset string) bool {
	if !strings.HasPrefix(asset, "/") || path.Clean(asset) != asset || strings.ContainsAny(asset, "\\%?#") || !postAssetExtension.MatchString(asset) {
		return false
	}
	for _, r := range asset {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	for _, prefix := range []string{"/_internal/", "/_content/", "/_owner/", "/posts/", "/books/", "/api/"} {
		if strings.HasPrefix(asset, prefix) {
			return false
		}
	}
	lower := strings.ToLower(asset)
	return !strings.HasPrefix(lower, "/favicon.") && !strings.HasPrefix(lower, "/favicon-") && !strings.HasPrefix(lower, "/favicon/")
}

// Reject duplicates before decoding, so a later field cannot silently replace a privacy rule.
func rejectDuplicateJSONKeys(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	seen := make(map[string]bool)
	for decoder.More() {
		if delim == '{' {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return fmt.Errorf("invalid or duplicate JSON key %q", key)
			}
			seen[name] = true
		}
		if err := rejectDuplicateJSONKeys(decoder); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}

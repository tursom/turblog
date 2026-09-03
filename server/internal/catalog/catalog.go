package catalog

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"
)

var articlePathPattern = regexp.MustCompile(`^/posts/([a-z0-9]+(?:-[a-z0-9]+)*)/$`)
var bookSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var bookDetailPathPattern = regexp.MustCompile(`^/books/([a-z0-9]+(?:-[a-z0-9]+)*)/$`)
var bookChapterPathPattern = regexp.MustCompile(`^/books/([a-z0-9]+(?:-[a-z0-9]+)*)/([a-z0-9]+(?:-[a-z0-9]+)*)/$`)

type sitemap struct {
	URLs []struct {
		Location string `xml:"loc"`
	} `xml:"url"`
}

type bookAccessManifest struct {
	Version      int       `json:"version"`
	PrivateBooks *[]string `json:"privateBooks"`
}

type Catalog struct {
	slugs        map[string]struct{}
	bookSlugs    map[string]struct{}
	bookChapters map[string]struct{}
}

func Load(path string) (*Catalog, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read sitemap: %w", err)
	}
	var document sitemap
	if err := xml.Unmarshal(contents, &document); err != nil {
		return nil, fmt.Errorf("parse sitemap: %w", err)
	}
	if len(document.URLs) == 0 {
		return nil, errors.New("sitemap contains no URLs")
	}

	articles := &Catalog{
		slugs:        make(map[string]struct{}),
		bookSlugs:    make(map[string]struct{}),
		bookChapters: make(map[string]struct{}),
	}
	for _, entry := range document.URLs {
		location, err := url.Parse(entry.Location)
		if err != nil || location.Hostname() == "" {
			continue
		}
		matches := articlePathPattern.FindStringSubmatch(location.EscapedPath())
		if len(matches) == 2 {
			articles.slugs[matches[1]] = struct{}{}
			continue
		}
		bookDetailMatches := bookDetailPathPattern.FindStringSubmatch(location.EscapedPath())
		if len(bookDetailMatches) == 2 {
			articles.bookSlugs[bookDetailMatches[1]] = struct{}{}
			continue
		}
		bookChapterMatches := bookChapterPathPattern.FindStringSubmatch(location.EscapedPath())
		if len(bookChapterMatches) == 3 {
			articles.bookSlugs[bookChapterMatches[1]] = struct{}{}
			articles.bookChapters[bookChapterMatches[1]+"/"+bookChapterMatches[2]] = struct{}{}
		}
	}
	if len(articles.slugs) == 0 && len(articles.bookSlugs) == 0 && len(articles.bookChapters) == 0 {
		return nil, errors.New("sitemap contains no absolute content URLs")
	}
	return articles, nil
}

func LoadBookAccessManifest(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read book access manifest: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var manifest bookAccessManifest
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("parse book access manifest: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return nil, fmt.Errorf("parse book access manifest: %w", err)
	}
	if manifest.Version != 1 {
		return nil, fmt.Errorf("book access manifest version = %d, want 1", manifest.Version)
	}
	if manifest.PrivateBooks == nil {
		return nil, errors.New("book access manifest is missing privateBooks")
	}

	privateBooks := append([]string(nil), (*manifest.PrivateBooks)...)
	seen := make(map[string]struct{}, len(privateBooks))
	for _, slug := range privateBooks {
		if !bookSlugPattern.MatchString(slug) {
			return nil, fmt.Errorf("book access manifest contains invalid book slug %q", slug)
		}
		if _, exists := seen[slug]; exists {
			return nil, fmt.Errorf("book access manifest contains duplicate book slug %q", slug)
		}
		seen[slug] = struct{}{}
	}
	sort.Strings(privateBooks)
	return privateBooks, nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("manifest must contain one JSON object")
		}
		return err
	}
	return nil
}

func BookSlugFromContentPath(path string) (string, bool) {
	if matches := bookDetailPathPattern.FindStringSubmatch(path); len(matches) == 2 {
		return matches[1], true
	}
	if matches := bookChapterPathPattern.FindStringSubmatch(path); len(matches) == 3 {
		return matches[1], true
	}
	return "", false
}

func (c *Catalog) ContainsBookContentPath(path string) bool {
	if matches := bookDetailPathPattern.FindStringSubmatch(path); len(matches) == 2 {
		return c.ContainsBook(matches[1])
	}
	_, ok := c.BookChapterIDFromPath(path)
	return ok
}

func (c *Catalog) BookChapterIDFromPath(path string) (string, bool) {
	matches := bookChapterPathPattern.FindStringSubmatch(path)
	if len(matches) != 3 {
		return "", false
	}
	id := matches[1] + "/" + matches[2]
	if _, ok := c.bookChapters[id]; !ok {
		return "", false
	}
	return id, true
}

func (c *Catalog) BookChapterIDs() []string {
	ids := make([]string, 0, len(c.bookChapters))
	for id := range c.bookChapters {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (c *Catalog) ContainsBook(slug string) bool {
	_, ok := c.bookSlugs[slug]
	return ok
}

func (c *Catalog) Contains(slug string) bool {
	_, ok := c.slugs[slug]
	return ok
}

func (c *Catalog) SlugFromPath(path string) (string, bool) {
	matches := articlePathPattern.FindStringSubmatch(path)
	if len(matches) != 2 || !c.Contains(matches[1]) {
		return "", false
	}
	return matches[1], true
}

func (c *Catalog) Slugs() []string {
	slugs := make([]string, 0, len(c.slugs))
	for slug := range c.slugs {
		slugs = append(slugs, slug)
	}
	sort.Strings(slugs)
	return slugs
}

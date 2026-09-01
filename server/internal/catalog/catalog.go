package catalog

import (
	"encoding/xml"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
)

var articlePathPattern = regexp.MustCompile(`^/posts/([a-z0-9]+(?:-[a-z0-9]+)*)/$`)
var bookChapterPathPattern = regexp.MustCompile(`^/books/([a-z0-9]+(?:-[a-z0-9]+)*)/([a-z0-9]+(?:-[a-z0-9]+)*)/$`)

type sitemap struct {
	URLs []struct {
		Location string `xml:"loc"`
	} `xml:"url"`
}

type Catalog struct {
	slugs        map[string]struct{}
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
		bookMatches := bookChapterPathPattern.FindStringSubmatch(location.EscapedPath())
		if len(bookMatches) == 3 {
			articles.bookChapters[bookMatches[1]+"/"+bookMatches[2]] = struct{}{}
		}
	}
	if len(articles.slugs) == 0 && len(articles.bookChapters) == 0 {
		return nil, errors.New("sitemap contains no absolute content URLs")
	}
	return articles, nil
}

func IsBookChapterPath(path string) bool {
	return bookChapterPathPattern.MatchString(path)
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

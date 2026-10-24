package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

type Client struct {
	HTTP  *http.Client
	Token string
}

// Page-number endpoints never silently truncate feedback at the first 100 records.
func getPages[T any](ctx context.Context, c *Client, i domain.Integration, path string) ([]T, error) {
	out := []T{}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	for page := 1; page <= 1000; page++ {
		var rows []T
		if err := c.do(ctx, i, "GET", path+sep+"per_page=100&page="+strconv.Itoa(page), nil, &rows); err != nil {
			return nil, err
		}
		out = append(out, rows...)
		if len(rows) < 100 {
			return out, nil
		}
	}
	return nil, fmt.Errorf("provider pagination exceeded page limit")
}

func New(token string) *Client {
	return &Client{Token: token, HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) do(ctx context.Context, i domain.Integration, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		reader = bytes.NewReader(b)
	}
	base := strings.TrimRight(i.BaseURL, "/")
	if base == "" {
		switch i.Provider {
		case "github":
			base = "https://api.github.com"
		case "gitlab":
			base = "https://gitlab.com/api/v4"
		case "linear":
			base = "https://api.linear.app"
		default:
			return fmt.Errorf("provider base URL is required")
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, base+path, reader)
	if e != nil {
		return e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	switch i.Provider {
	case "gitlab":
		req.Header.Set("PRIVATE-TOKEN", c.Token)
	case "jira":
		req.SetBasicAuth(i.Username, c.Token)
	case "linear":
		req.Header.Set("Authorization", c.Token)
	default:
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, e := c.HTTP.Do(req)
	if e != nil {
		return fmt.Errorf("provider request failed: %w", e)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s returned HTTP %d; check credentials, permissions and provider availability", i.Provider, res.StatusCode)
	}
	if out == nil || res.StatusCode == 204 {
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}
func pathRepo(i domain.Integration, r domain.Repository) string {
	if i.Provider == "gitlab" {
		return "/projects/" + url.PathEscape(r.ProviderRepo)
	}
	parts := strings.Split(r.ProviderRepo, "/")
	for n := range parts {
		parts[n] = url.PathEscape(parts[n])
	}
	return "/repos/" + strings.Join(parts, "/")
}
func (c *Client) graphql(ctx context.Context, i domain.Integration, query string, variables any, out any) error {
	var response struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if e := c.do(ctx, i, "POST", "/graphql", map[string]any{"query": query, "variables": variables}, &response); e != nil {
		return e
	}
	if len(response.Errors) > 0 {
		return fmt.Errorf("Linear rejected query: %s", response.Errors[0].Message)
	}
	return json.Unmarshal(response.Data, out)
}

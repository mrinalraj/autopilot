package providers

import (
	"context"
	"fmt"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

// Mergeability is separate from merged/closed state. Unknown is not permission to merge.
func (c *Client) Mergeability(ctx context.Context, i domain.Integration, r domain.Repository, number int) (string, error) {
	base := pathRepo(i, r)
	if i.Provider == "github" {
		var pr struct {
			Mergeable *bool `json:"mergeable"`
		}
		if e := c.do(ctx, i, "GET", fmt.Sprintf("%s/pulls/%d", base, number), nil, &pr); e != nil {
			return "unknown", e
		}
		if pr.Mergeable == nil {
			return "unknown", nil
		}
		if *pr.Mergeable {
			return "mergeable", nil
		}
		return "conflicts", nil
	}
	if i.Provider == "gitlab" {
		var mr struct {
			Status string `json:"detailed_merge_status"`
		}
		if e := c.do(ctx, i, "GET", fmt.Sprintf("%s/merge_requests/%d", base, number), nil, &mr); e != nil {
			return "unknown", e
		}
		if mr.Status == "" {
			return "unknown", nil
		}
		return mr.Status, nil
	}
	return "unknown", fmt.Errorf("mergeability is unavailable for this provider")
}
func (c *Client) Comments(ctx context.Context, i domain.Integration, r domain.Repository, number int) ([]domain.Feedback, error) {
	type comment struct {
		ID     int64  `json:"id"`
		Body   string `json:"body"`
		URL    string `json:"html_url"`
		System bool   `json:"system"`
	}
	path := fmt.Sprintf("%s/issues/%d/comments", pathRepo(i, r), number)
	if i.Provider == "gitlab" {
		path = fmt.Sprintf("%s/merge_requests/%d/notes", pathRepo(i, r), number)
	} else if i.Provider != "github" {
		return nil, fmt.Errorf("comments unavailable")
	}
	all, e := getPages[comment](ctx, c, i, path)
	if e != nil {
		return nil, e
	}
	out := []domain.Feedback{}
	for _, v := range all {
		if !v.System {
			out = append(out, domain.Feedback{ID: fmt.Sprint(v.ID), Body: v.Body, URL: v.URL})
		}
	}
	return out, nil
}

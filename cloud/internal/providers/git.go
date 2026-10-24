package providers

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

func (c *Client) Observe(ctx context.Context, i domain.Integration, r domain.Repository, run domain.Run) (domain.ChangeRequest, error) {
	branch := ""
	for _, w := range run.Worktrees {
		if w.RepositoryID == r.ID {
			branch = w.Branch
		}
	}
	if branch == "" {
		return domain.ChangeRequest{}, fmt.Errorf("run has no worktree for repository")
	}
	base := pathRepo(i, r)
	change := domain.ChangeRequest{RunID: run.ID, RepositoryID: r.ID, State: "missing", Checks: "unknown", Feedback: []domain.Feedback{}}
	if i.Provider == "github" {
		var prs []struct {
			Number   int     `json:"number"`
			HTMLURL  string  `json:"html_url"`
			Title    string  `json:"title"`
			State    string  `json:"state"`
			MergedAt *string `json:"merged_at"`
			Head     struct {
				SHA string `json:"sha"`
			} `json:"head"`
		}
		owner := strings.Split(r.ProviderRepo, "/")[0]
		if e := c.do(ctx, i, "GET", base+"/pulls?state=all&head="+url.QueryEscape(owner+":"+branch)+"&per_page=100", nil, &prs); e != nil {
			return change, e
		}
		if len(prs) == 0 {
			return change, nil
		}
		p := prs[0]
		change.Number = p.Number
		change.URL = p.HTMLURL
		change.Title = p.Title
		change.HeadSHA = p.Head.SHA
		change.State = p.State
		if p.MergedAt != nil {
			change.State = "merged"
		}
		var checks struct {
			CheckRuns []struct {
				Status     string `json:"status"`
				Conclusion string `json:"conclusion"`
				Name       string `json:"name"`
				HTMLURL    string `json:"html_url"`
				ID         int64  `json:"id"`
			} `json:"check_runs"`
		}
		change.Checks = "none"
		for page := 1; page <= 1000; page++ {
			if e := c.do(ctx, i, "GET", base+"/commits/"+p.Head.SHA+fmt.Sprintf("/check-runs?per_page=100&page=%d", page), nil, &checks); e != nil {
				return change, e
			}
			for _, ch := range checks.CheckRuns {
				state := "success"
				if ch.Status != "completed" {
					state = "pending"
				} else if ch.Conclusion != "success" && ch.Conclusion != "neutral" && ch.Conclusion != "skipped" {
					state = "failed"
					change.Feedback = append(change.Feedback, domain.Feedback{ID: fmt.Sprintf("check:%d:%s", ch.ID, p.Head.SHA), Body: "Check failed: " + ch.Name, URL: ch.HTMLURL})
				}
				change.Checks = worst(change.Checks, state)
			}
			if len(checks.CheckRuns) < 100 {
				break
			}
			if page == 1000 {
				return change, fmt.Errorf("check pagination exceeded limit")
			}
		}

		var combined struct {
			State string `json:"state"`
			Total int    `json:"total_count"`
		}
		if e := c.do(ctx, i, "GET", base+"/commits/"+p.Head.SHA+"/status", nil, &combined); e != nil {
			return change, e
		}
		if combined.Total > 0 {
			state := combined.State
			if state == "failure" || state == "error" {
				state = "failed"
				change.Feedback = append(change.Feedback, domain.Feedback{ID: "status:" + p.Head.SHA, Body: "Commit status checks failed", URL: p.HTMLURL})
			}
			change.Checks = worst(change.Checks, state)
		}
		type CommentsRecord struct {
			ID      int64  `json:"id"`
			Body    string `json:"body"`
			HTMLURL string `json:"html_url"`
		}
		comments, e := getPages[CommentsRecord](ctx, c, i, fmt.Sprintf("%s/pulls/%d/comments", base, p.Number))
		if e != nil {
			return change, e
		}
		for _, v := range comments {
			change.Feedback = append(change.Feedback, domain.Feedback{ID: fmt.Sprint(v.ID), Body: v.Body, URL: v.HTMLURL})
		}
		type ReviewsRecord struct {
			ID      int64  `json:"id"`
			State   string `json:"state"`
			Body    string `json:"body"`
			HTMLURL string `json:"html_url"`
		}
		reviews, e := getPages[ReviewsRecord](ctx, c, i, fmt.Sprintf("%s/pulls/%d/reviews", base, p.Number))
		if e != nil {
			return change, e
		}
		for _, v := range reviews {
			if v.State == "CHANGES_REQUESTED" {
				change.Feedback = append(change.Feedback, domain.Feedback{ID: fmt.Sprintf("review:%d", v.ID), Body: v.Body, URL: v.HTMLURL})
			}
		}
		return change, nil
	}
	if i.Provider != "gitlab" {
		return change, fmt.Errorf("Git provider does not support change requests")
	}
	var mrs []struct {
		IID    int    `json:"iid"`
		WebURL string `json:"web_url"`
		Title  string `json:"title"`
		State  string `json:"state"`
		SHA    string `json:"sha"`
	}
	if e := c.do(ctx, i, "GET", base+"/merge_requests?scope=all&state=all&source_branch="+url.QueryEscape(branch)+"&per_page=100", nil, &mrs); e != nil {
		return change, e
	}
	if len(mrs) == 0 {
		return change, nil
	}
	m := mrs[0]
	change.Number = m.IID
	change.URL = m.WebURL
	change.Title = m.Title
	change.State = m.State
	if change.State == "opened" {
		change.State = "open"
	}
	change.HeadSHA = m.SHA
	var mr struct {
		Pipeline *struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
			WebURL string `json:"web_url"`
		} `json:"head_pipeline"`
	}
	if e := c.do(ctx, i, "GET", fmt.Sprintf("%s/merge_requests/%d", base, m.IID), nil, &mr); e != nil {
		return change, e
	}
	change.Checks = "none"
	if mr.Pipeline != nil {
		switch mr.Pipeline.Status {
		case "success", "skipped":
			change.Checks = "success"
		case "failed", "canceled":
			change.Checks = "failed"
			change.Feedback = append(change.Feedback, domain.Feedback{ID: fmt.Sprintf("pipeline:%d", mr.Pipeline.ID), Body: "Pipeline " + mr.Pipeline.Status, URL: mr.Pipeline.WebURL})
		default:
			change.Checks = "pending"
		}
	}
	type NotesRecord struct {
		ID         int64  `json:"id"`
		Body       string `json:"body"`
		System     bool   `json:"system"`
		Resolvable bool   `json:"resolvable"`
		Resolved   bool   `json:"resolved"`
	}
	notes, e := getPages[NotesRecord](ctx, c, i, fmt.Sprintf("%s/merge_requests/%d/notes", base, m.IID))
	if e != nil {
		return change, e
	}
	for _, n := range notes {
		if !n.System && !n.Resolved {
			change.Feedback = append(change.Feedback, domain.Feedback{ID: fmt.Sprint(n.ID), Body: n.Body, URL: m.WebURL})
		}
	}
	return change, nil
}
func worst(a, b string) string {
	rank := map[string]int{"none": 0, "success": 1, "pending": 2, "unknown": 3, "failed": 4}
	if rank[b] > rank[a] {
		return b
	}
	return a
}
func (c *Client) Create(ctx context.Context, i domain.Integration, r domain.Repository, run domain.Run, title, body string) (domain.ChangeRequest, error) {
	existing, e := c.Observe(ctx, i, r, run)
	if e != nil {
		return existing, e
	}
	if existing.State != "missing" {
		return existing, nil
	}
	branch := ""
	for _, w := range run.Worktrees {
		if w.RepositoryID == r.ID {
			branch = w.Branch
		}
	}
	base := pathRepo(i, r)
	if i.Provider == "github" {
		e = c.do(ctx, i, "POST", base+"/pulls", map[string]any{"title": title, "body": body, "head": branch, "base": r.DefaultBranch, "draft": true}, nil)
	} else if i.Provider == "gitlab" {
		e = c.do(ctx, i, "POST", base+"/merge_requests", map[string]any{"title": "Draft: " + title, "description": body, "source_branch": branch, "target_branch": r.DefaultBranch}, nil)
	} else {
		e = fmt.Errorf("unsupported provider")
	}
	if e != nil {
		return existing, e
	}
	return c.Observe(ctx, i, r, run)
}

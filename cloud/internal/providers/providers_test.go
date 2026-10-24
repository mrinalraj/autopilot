package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

func TestLinearPaginationMappingAndFailure(t *testing.T) {
	page := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "secret" {
			t.Error("wrong authentication")
		}
		var request struct {
			Variables map[string]any `json:"variables"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		page++
		if page == 2 && request.Variables["after"] != "cursor-1" {
			t.Error("missing pagination cursor")
		}
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"issues": map[string]any{
			"nodes":    []any{map[string]any{"id": fmt.Sprint(page), "title": "Issue", "identifier": fmt.Sprintf("TEAM-%d", page), "state": map[string]string{"id": "review", "type": "started", "name": "Review"}}},
			"pageInfo": map[string]any{"hasNextPage": page == 1, "endCursor": fmt.Sprintf("cursor-%d", page)},
		}}})
	}))
	defer srv.Close()
	c := New("secret")
	i := domain.Integration{Provider: "linear", BaseURL: srv.URL, Scope: "TEAM", StatusMap: map[string]string{"review": "in_review"}}
	issues, err := c.Pull(context.Background(), i, "2026-01-01T00:00:00Z")
	if err != nil || len(issues) != 2 || issues[1].Status != "in_review" {
		t.Fatalf("pagination/mapping: %+v %v", issues, err)
	}
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		fmt.Fprint(w, "private token: secret")
	}))
	defer denied.Close()
	i.BaseURL = denied.URL
	issues, err = c.Pull(context.Background(), i, "")
	if err == nil || issues != nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("provider failure returned partial data or leaked response")
	}
}

func TestJiraUsesAssigneeOnIncrementalSyncAndValidTransition(t *testing.T) {
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, _ := r.BasicAuth()
		if user != "user@example.test" || pass != "secret" {
			t.Error("wrong Jira auth")
		}
		if r.URL.Path == "/rest/api/3/search/jql" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if !strings.Contains(body["jql"].(string), "assignee = currentUser() AND updated >=") {
				t.Error("incremental query lost assignee scope")
			}
			fmt.Fprint(w, `{"isLast":true,"issues":[{"id":"1","key":"WEB-1","fields":{"summary":"Issue","description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Details"}]}]},"status":{"id":"3","name":"In progress","statusCategory":{"key":"indeterminate"}}}}]}`)
			return
		}
		if r.Method == "GET" {
			fmt.Fprint(w, `{"transitions":[{"id":"42","to":{"id":"done"}}]}`)
			return
		}
		posts++
		var body map[string]map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["transition"]["id"] != "42" {
			t.Error("sent status id instead of transition id")
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := New("secret")
	i := domain.Integration{Provider: "jira", BaseURL: srv.URL, Username: "user@example.test"}
	issues, err := c.Pull(context.Background(), i, "2026-01-01T00:00:00Z")
	if err != nil || len(issues) != 1 || issues[0].Description != "Details\n" {
		t.Fatalf("Jira: %+v %v", issues, err)
	}
	if err = c.Transition(context.Background(), i, issues[0], "done"); err != nil {
		t.Fatal(err)
	}
	if err = c.Transition(context.Background(), i, issues[0], "forbidden"); err == nil || posts != 1 {
		t.Fatal("unavailable transition was posted")
	}
}

func TestGitProvidersNormalizeChecksAndMergedState(t *testing.T) {
	for _, provider := range []string{"github", "gitlab"} {
		t.Run(provider, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Fatal("existing change should not be created twice")
				}
				path := r.URL.Path
				switch {
				case strings.HasSuffix(path, "/pulls"):
					fmt.Fprint(w, `[{"number":7,"html_url":"https://github.test/pr/7","state":"closed","merged_at":"2026-01-01","head":{"sha":"abc"}}]`)
				case strings.HasSuffix(path, "/check-runs"):
					fmt.Fprint(w, `{"check_runs":[{"id":8,"status":"completed","conclusion":"failure","name":"Unit tests"}]}`)
				case strings.HasSuffix(path, "/status"):
					fmt.Fprint(w, `{"state":"success","total_count":0}`)
				case strings.HasSuffix(path, "/merge_requests"):
					if r.Header.Get("PRIVATE-TOKEN") != "secret" {
						t.Error("missing GitLab token")
					}
					if !strings.Contains(r.URL.EscapedPath(), "group%2Fsub%2Frepo") {
						t.Error("nested GitLab project path not encoded")
					}
					fmt.Fprint(w, `[{"iid":7,"state":"merged","sha":"abc","web_url":"https://gitlab.test/mr/7"}]`)
				case strings.HasSuffix(path, "/merge_requests/7"):
					fmt.Fprint(w, `{"head_pipeline":{"id":8,"status":"failed"}}`)
				default:
					fmt.Fprint(w, `[]`)
				}
			}))
			defer srv.Close()
			c := New("secret")
			i := domain.Integration{Provider: provider, BaseURL: srv.URL}
			repo := domain.Repository{Meta: domain.Meta{ID: "repo"}, ProviderRepo: "group/sub/repo"}
			run := domain.Run{Meta: domain.Meta{ID: "run"}, Worktrees: []domain.Worktree{{RepositoryID: "repo", Branch: "autopilot/run"}}}
			change, err := c.Create(context.Background(), i, repo, run, "Title", "Body")
			if err != nil || change.State != "merged" || change.Checks != "failed" || len(change.Feedback) != 1 {
				t.Fatalf("normalized change %+v: %v", change, err)
			}
		})
	}
}

func TestFeedbackPaginationAndRedirectCredentialProtection(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, target.URL, 302)
			return
		}
		rows := []int{}
		if r.URL.Query().Get("page") == "1" {
			for n := 0; n < 100; n++ {
				rows = append(rows, n)
			}
		} else {
			rows = []int{100}
		}
		json.NewEncoder(w).Encode(rows)
	}))
	defer srv.Close()
	c := New("secret")
	i := domain.Integration{Provider: "github", BaseURL: srv.URL}
	rows, err := getPages[int](context.Background(), c, i, "/feedback")
	if err != nil || len(rows) != 101 {
		t.Fatal("feedback was truncated", err)
	}
	if err = c.do(context.Background(), i, "GET", "/redirect", nil, nil); err == nil || calls != 0 {
		t.Fatal("forwarded credentials through redirect")
	}
}

func TestMergeabilityDoesNotTreatUnknownAsMergeable(t *testing.T) {
	for _, tc := range []struct{ provider, body, want string }{{"github", `{"mergeable":null}`, "unknown"}, {"github", `{"mergeable":false}`, "conflicts"}, {"github", `{"mergeable":true}`, "mergeable"}, {"gitlab", `{"detailed_merge_status":"checking"}`, "checking"}, {"gitlab", `{}`, "unknown"}} {
		t.Run(tc.provider+tc.want, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Fatal("status check mutated provider")
				}
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()
			got, e := New("secret").Mergeability(context.Background(), domain.Integration{Provider: tc.provider, BaseURL: srv.URL}, domain.Repository{ProviderRepo: "org/repo"}, 1)
			if e != nil || got != tc.want {
				t.Fatal(got, e)
			}
		})
	}
}

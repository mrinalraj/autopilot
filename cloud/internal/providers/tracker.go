package providers

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

func (c *Client) Pull(ctx context.Context, i domain.Integration, since string) ([]domain.Issue, error) {
	if i.Provider == "linear" {
		return c.linearPull(ctx, i, since)
	}
	return c.jiraPull(ctx, i, since)
}
func (c *Client) linearPull(ctx context.Context, i domain.Integration, since string) ([]domain.Issue, error) {
	filter := map[string]any{}
	if since != "" {
		filter["updatedAt"] = map[string]string{"gte": since}
	}
	if i.Scope != "" {
		filter["team"] = map[string]any{"key": map[string]any{"in": splitScope(i.Scope)}}
	} else {
		var viewer struct {
			Viewer struct {
				ID string `json:"id"`
			} `json:"viewer"`
		}
		if err := c.graphql(ctx, i, `{viewer{id}}`, nil, &viewer); err != nil {
			return nil, err
		}
		filter["assignee"] = map[string]any{"id": map[string]string{"eq": viewer.Viewer.ID}}
	}
	var cursor any
	out := []domain.Issue{}
	for page := 0; page < 1000; page++ {
		var data struct {
			Issues struct {
				Nodes []struct {
					ID          string `json:"id"`
					Identifier  string `json:"identifier"`
					Title       string `json:"title"`
					Description string `json:"description"`
					URL         string `json:"url"`
					UpdatedAt   string `json:"updatedAt"`
					Priority    int    `json:"priority"`
					State       struct {
						ID   string `json:"id"`
						Name string `json:"name"`
						Type string `json:"type"`
					} `json:"state"`
					Labels struct {
						Nodes []struct {
							Name string `json:"name"`
						} `json:"nodes"`
					} `json:"labels"`
				} `json:"nodes"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"issues"`
		}
		query := `query($filter:IssueFilter,$after:String){issues(first:100,after:$after,filter:$filter){nodes{id identifier title description url updatedAt priority state{id name type} labels{nodes{name}}} pageInfo{hasNextPage endCursor}}}`
		if e := c.graphql(ctx, i, query, map[string]any{"filter": filter, "after": cursor}, &data); e != nil {
			return nil, e
		}
		for _, v := range data.Issues.Nodes {
			state := mapped(i, v.State.ID, v.State.Type)
			labels := []string{}
			for _, l := range v.Labels.Nodes {
				labels = append(labels, l.Name)
			}
			out = append(out, domain.Issue{WorkspaceID: i.WorkspaceID, Identifier: v.Identifier, Title: v.Title, Description: v.Description, Status: state, Priority: v.Priority, Labels: labels, Source: "linear", IntegrationID: i.ID, ExternalID: v.ID, ExternalURL: v.URL, ExternalStatusID: v.State.ID, ExternalStatus: v.State.Name, SourceUpdatedAt: v.UpdatedAt})
		}
		if !data.Issues.PageInfo.HasNextPage {
			return out, nil
		}
		if data.Issues.PageInfo.EndCursor == cursor {
			return nil, fmt.Errorf("Linear pagination did not advance")
		}
		cursor = data.Issues.PageInfo.EndCursor
	}
	return nil, fmt.Errorf("Linear sync exceeded page limit")
}
func splitScope(s string) []string {
	out := []string{}
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
func mapped(i domain.Integration, id, kind string) string {
	if v := i.StatusMap[id]; v != "" {
		return v
	}
	switch strings.ToLower(kind) {
	case "started", "indeterminate":
		return "in_progress"
	case "completed", "done":
		return "done"
	case "canceled", "cancelled":
		return "canceled"
	case "unstarted", "new":
		return "ready"
	default:
		return "backlog"
	}
}
func (c *Client) jiraPull(ctx context.Context, i domain.Integration, since string) ([]domain.Issue, error) {
	jql := "assignee = currentUser()"
	if i.Scope != "" {
		keys := []string{}
		for _, v := range splitScope(i.Scope) {
			keys = append(keys, strconv.Quote(v))
		}
		jql = "project in (" + strings.Join(keys, ",") + ")"
	}
	if since != "" {
		stamp := strings.ReplaceAll(since[:min(len(since), 16)], "T", " ")
		if jql != "" {
			jql += " AND "
		}
		jql += "updated >= " + strconv.Quote(stamp)
	}
	if jql == "" {
		jql = "assignee = currentUser()"
	}
	jql += " ORDER BY updated ASC"
	out := []domain.Issue{}
	next := ""
	for page := 0; page < 1000; page++ {
		body := map[string]any{"jql": jql, "maxResults": 100, "fields": []string{"summary", "description", "status", "labels", "updated", "priority"}}
		if next != "" {
			body["nextPageToken"] = next
		}
		var data struct {
			Next   string `json:"nextPageToken"`
			IsLast bool   `json:"isLast"`
			Issues []struct {
				ID     string `json:"id"`
				Key    string `json:"key"`
				Fields struct {
					Summary     string   `json:"summary"`
					Description any      `json:"description"`
					Updated     string   `json:"updated"`
					Labels      []string `json:"labels"`
					Status      struct {
						ID       string `json:"id"`
						Name     string `json:"name"`
						Category struct {
							Key string `json:"key"`
						} `json:"statusCategory"`
					} `json:"status"`
				} `json:"fields"`
			} `json:"issues"`
		}
		if e := c.do(ctx, i, "POST", "/rest/api/3/search/jql", body, &data); e != nil {
			return nil, e
		}
		for _, v := range data.Issues {
			out = append(out, domain.Issue{WorkspaceID: i.WorkspaceID, Identifier: v.Key, Title: v.Fields.Summary, Description: adfText(v.Fields.Description), Status: mapped(i, v.Fields.Status.ID, v.Fields.Status.Category.Key), Labels: v.Fields.Labels, Source: "jira", IntegrationID: i.ID, ExternalID: v.ID, ExternalURL: strings.TrimRight(i.BaseURL, "/") + "/browse/" + v.Key, ExternalStatusID: v.Fields.Status.ID, ExternalStatus: v.Fields.Status.Name, SourceUpdatedAt: v.Fields.Updated})
		}
		if data.IsLast || data.Next == "" {
			return out, nil
		}
		if next == data.Next {
			return nil, fmt.Errorf("Jira pagination did not advance")
		}
		next = data.Next
	}
	return nil, fmt.Errorf("Jira sync exceeded page limit")
}
func adfText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		if s, ok := x["text"].(string); ok {
			return s
		}
		text := adfText(x["content"])
		if x["type"] == "paragraph" || x["type"] == "heading" {
			text += "\n"
		}
		return text
	case []any:
		out := ""
		for _, e := range x {
			out += adfText(e)
		}
		return out
	}
	return ""
}
func (c *Client) Statuses(ctx context.Context, i domain.Integration) (map[string]string, error) {
	out := map[string]string{}
	if i.Provider == "linear" {
		var data struct {
			WorkflowStates struct {
				Nodes []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
					Team struct {
						Key string `json:"key"`
					} `json:"team"`
				} `json:"nodes"`
			} `json:"workflowStates"`
		}
		if e := c.graphql(ctx, i, `{workflowStates(first:250){nodes{id name team{key}}}}`, nil, &data); e != nil {
			return nil, e
		}
		for _, s := range data.WorkflowStates.Nodes {
			out[s.ID] = s.Team.Key + " · " + s.Name
		}
		return out, nil
	}
	var data []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if e := c.do(ctx, i, "GET", "/rest/api/3/status", nil, &data); e != nil {
		return nil, e
	}
	for _, s := range data {
		out[s.ID] = s.Name
	}
	return out, nil
}
func (c *Client) Transition(ctx context.Context, i domain.Integration, issue domain.Issue, status string) error {
	if i.Provider == "linear" {
		var data struct {
			IssueUpdate struct {
				Success bool `json:"success"`
			} `json:"issueUpdate"`
		}
		e := c.graphql(ctx, i, `mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success}}`, map[string]string{"id": issue.ExternalID, "state": status}, &data)
		if e == nil && !data.IssueUpdate.Success {
			return fmt.Errorf("Linear did not accept transition")
		}
		return e
	}
	path := "/rest/api/3/issue/" + url.PathEscape(issue.ExternalID) + "/transitions"
	var data struct {
		Transitions []struct {
			ID string `json:"id"`
			To struct {
				ID string `json:"id"`
			} `json:"to"`
		} `json:"transitions"`
	}
	if e := c.do(ctx, i, "GET", path, nil, &data); e != nil {
		return e
	}
	for _, t := range data.Transitions {
		if t.To.ID == status {
			return c.do(ctx, i, "POST", path, map[string]any{"transition": map[string]string{"id": t.ID}}, nil)
		}
	}
	return fmt.Errorf("the requested status is not an available Jira transition")
}
func (c *Client) Comment(ctx context.Context, i domain.Integration, issue domain.Issue, body string) error {
	if i.Provider == "linear" {
		var data struct {
			CommentCreate struct {
				Success bool `json:"success"`
			} `json:"commentCreate"`
		}
		e := c.graphql(ctx, i, `mutation($issue:String!,$body:String!){commentCreate(input:{issueId:$issue,body:$body}){success}}`, map[string]string{"issue": issue.ExternalID, "body": body}, &data)
		if e == nil && !data.CommentCreate.Success {
			return fmt.Errorf("Linear rejected comment")
		}
		return e
	}
	return c.do(ctx, i, "POST", "/rest/api/3/issue/"+url.PathEscape(issue.ExternalID)+"/comment", map[string]any{"body": map[string]any{"version": 1, "type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": body}}}}}}, nil)
}

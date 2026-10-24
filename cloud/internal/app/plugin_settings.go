package app

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/providers"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func (a *App) githubCLIToken(ctx context.Context, i domain.Integration) (string, error) {
	if strings.TrimSpace(i.CLIAccount) == "" {
		return "", fmt.Errorf("specify the GitHub CLI account username")
	}
	host := "github.com"
	if i.BaseURL != "" {
		u, e := url.Parse(i.BaseURL)
		if e != nil {
			return "", e
		}
		host = u.Hostname()
		if host == "api.github.com" {
			host = "github.com"
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", host, "--user", i.CLIAccount)
	cmd.Env = a.baseEnv()
	raw, e := cmd.Output()
	if e != nil {
		return "", fmt.Errorf("could not read the selected GitHub CLI account; sign in with gh on this machine first")
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", fmt.Errorf("GitHub CLI returned no credential")
	}
	identity, e := providers.New(token).Identity(ctx, i)
	if e != nil {
		return "", e
	}
	if !strings.EqualFold(identity, i.CLIAccount) {
		return "", fmt.Errorf("CLI credential does not match the requested account")
	}
	return token, nil
}
func (a *App) VerifyIntegration(ctx context.Context, id string) (domain.Integration, error) {
	a.IntegrationOps.Lock()
	defer a.IntegrationOps.Unlock()
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil {
		return i, e
	}
	c, e := a.provider(i)
	if e != nil {
		return i, e
	}
	identity, e := c.Identity(ctx, i)
	if e != nil {
		i.Error = e.Error()
	} else {
		i.Error = ""
		i.VerifiedAccount = identity
		i.LastVerified = domain.Now()
	}
	i.Touch()
	save := a.save(ctx, i, i.ID, "integration.checked", "Checked "+i.Label)
	if e != nil {
		return i, e
	}
	return i, save
}
func watched(i domain.Integration, issue domain.Issue) bool {
	return i.Enabled && i.IntakeEnabled && slices.Contains(i.WatchStatuses, issue.ExternalStatusID) && issue.Status != "done" && issue.Status != "canceled"
}
func (a *App) reconcileIntake(ctx context.Context, q storage.Queryer, i domain.Integration, old, issue domain.Issue, known bool) error {
	eligible := watched(i, issue)
	entries, e := storage.List[domain.QueueEntry](ctx, q, "queue")
	if e != nil {
		return e
	}
	pending := false
	for _, entry := range entries {
		if entry.IssueID != issue.ID || entry.State != "pending" {
			continue
		}
		pending = true
		if !eligible {
			entry.State = "withdrawn"
			entry.Touch()
			if e = persist(ctx, q, entry); e != nil {
				return e
			}
		}
	}
	if !eligible || pending || i.LastSync == "" || (known && watched(i, old)) {
		return nil
	}
	version := issue.SourceUpdatedAt
	if version == "" {
		version = fmt.Sprint(issue.Revision)
	}
	fingerprint := i.ID + ":" + issue.ExternalID + ":" + issue.ExternalStatusID + ":" + version
	for _, entry := range entries {
		if entry.Fingerprint == fingerprint {
			return nil
		}
	}
	entry := domain.QueueEntry{Meta: domain.NewMeta(), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, IntegrationID: i.ID, State: "pending", Fingerprint: fingerprint}
	if e = persist(ctx, q, entry); e != nil {
		return e
	}
	return storage.Event(ctx, q, issue.ID, "issue.queued", "Queued "+issue.Identifier+" for planning")
}
func (a *App) QueueDecision(ctx context.Context, id string) error {
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		entry, e := storage.Get[domain.QueueEntry](ctx, q, "queue", id)
		if e != nil {
			return e
		}
		entry.State = "dismissed"
		entry.Touch()
		if e = persist(ctx, q, entry); e != nil {
			return e
		}
		return storage.Event(ctx, q, entry.IssueID, "queue.dismissed", "Removed from planning queue")
	})
}

type TicketCandidate struct {
	WorktreeID   string `json:"worktreeId"`
	WorktreeName string `json:"worktreeName"`
	Branch       string `json:"branch"`
	Identifier   string `json:"identifier"`
	IssueID      string `json:"issueId"`
	Linked       bool   `json:"linked"`
}

func (a *App) DiscoverTickets(ctx context.Context, id string) ([]TicketCandidate, error) {
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil {
		return nil, e
	}
	all, e := storage.List[domain.Worktree](ctx, a.Store.DB, "worktrees")
	if e != nil {
		return nil, e
	}
	issues, e := storage.List[domain.Issue](ctx, a.Store.DB, "issues")
	if e != nil {
		return nil, e
	}
	known := map[string]domain.Issue{}
	for _, issue := range issues {
		if issue.IntegrationID == id {
			known[strings.ToUpper(issue.Identifier)] = issue
		}
	}
	re := regexp.MustCompile(`(?i)(?:^|[^a-z0-9])([a-z][a-z0-9]+-[0-9]+)(?:[^0-9]|$)`)
	out := []TicketCandidate{}
	for _, w := range all {
		if w.WorkspaceID != i.WorkspaceID || w.Hidden {
			continue
		}
		seen := map[string]bool{}
		for _, match := range re.FindAllStringSubmatch(w.Branch+" "+w.Name, -1) {
			key := strings.ToUpper(match[1])
			if seen[key] {
				continue
			}
			seen[key] = true
			issue := known[key]
			out = append(out, TicketCandidate{WorktreeID: w.ID, WorktreeName: w.Name, Branch: w.Branch, Identifier: key, IssueID: issue.ID, Linked: issue.ID != "" && slices.Contains(w.IssueIDs, issue.ID)})
		}
	}
	return out, nil
}

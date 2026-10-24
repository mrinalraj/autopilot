package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/providers"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func (a *App) SaveIntegration(ctx context.Context, i domain.Integration, token string) (domain.Integration, error) {
	a.IntegrationOps.Lock()
	defer a.IntegrationOps.Unlock()
	if !slices.Contains([]string{"linear", "jira", "github", "gitlab"}, i.Provider) {
		return i, fmt.Errorf("unsupported integration")
	}
	if i.PollInterval == 0 {
		i.PollInterval = 60
	}
	if i.PollInterval < 10 || i.PollInterval > 86400 {
		return i, fmt.Errorf("poll interval must be between 10 and 86400 seconds")
	}
	if i.AuthMethod == "" {
		i.AuthMethod = "token"
	}
	if i.AuthMethod != "token" && i.AuthMethod != "cli" {
		return i, fmt.Errorf("this cloud distribution supports server tokens or a supported CLI account")
	}
	if i.AuthMethod == "cli" && i.Provider != "github" {
		return i, fmt.Errorf("CLI account selection is currently supported by the GitHub adapter")
	}
	if i.IntakeEnabled && len(i.WatchStatuses) == 0 {
		return i, fmt.Errorf("choose at least one watched status")
	}
	if i.ID == "" {
		i.Meta = domain.NewMeta()
		i.LastSync = ""
		i.LastFullSync = ""
		i.LastAttempt = ""
		i.VerifiedAccount = ""
		i.LastVerified = ""
		i.WebhookEnabled = false
		i.WebhookPending = false
		i.LastWebhook = ""
	} else {
		old, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", i.ID)
		if e != nil {
			return i, e
		}
		if old.Revision != i.Revision {
			return i, fmt.Errorf("integration changed; refresh and retry")
		}
		if old.Provider != i.Provider || old.WorkspaceID != i.WorkspaceID {
			return i, fmt.Errorf("integration identity cannot change")
		}
		i.Meta = old.Meta
		i.Touch()
		i.LastSync = old.LastSync
		i.LastFullSync = old.LastFullSync
		i.LastAttempt = old.LastAttempt
		i.WebhookEnabled = old.WebhookEnabled
		i.WebhookPending = old.WebhookPending
		i.LastWebhook = old.LastWebhook
		i.VerifiedAccount = old.VerifiedAccount
		i.LastVerified = old.LastVerified
	}
	if i.BaseURL != "" {
		u, e := url.Parse(i.BaseURL)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return i, fmt.Errorf("integration base URL must be HTTPS without credentials")
		}
	}
	if i.Provider == "jira" && (i.BaseURL == "" || i.Username == "") {
		return i, fmt.Errorf("Jira needs a site URL and account email")
	}
	if i.Label == "" {
		i.Label = i.Provider
	}
	for key, state := range i.StatusMap {
		if state == "" {
			delete(i.StatusMap, key)
			continue
		}
		if !slices.Contains(domain.Statuses, state) {
			return i, fmt.Errorf("invalid mapped status")
		}
	}
	if i.AuthMethod == "cli" {
		var e error
		token, e = a.githubCLIToken(ctx, i)
		if e != nil {
			return i, e
		}
	}
	if token != "" {
		i.VerifiedAccount = ""
		i.LastVerified = ""
		if e := a.SetSecret("integration-"+i.ID, token); e != nil {
			return i, e
		}
	} else if _, e := a.Secret("integration-" + i.ID); e != nil {
		return i, fmt.Errorf("integration token is required")
	}
	return i, a.Store.Tx(ctx, func(q storage.Queryer) error {
		if e := persist(ctx, q, i); e != nil {
			return e
		}
		entries, e := storage.List[domain.QueueEntry](ctx, q, "queue")
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if entry.IntegrationID != i.ID || entry.State != "pending" {
				continue
			}
			issue, e := storage.Get[domain.Issue](ctx, q, "issues", entry.IssueID)
			if e != nil {
				return e
			}
			if !watched(i, issue) {
				entry.State = "withdrawn"
				entry.Touch()
				if e = persist(ctx, q, entry); e != nil {
					return e
				}
			}
		}
		return storage.Event(ctx, q, i.ID, "integration.saved", "Saved "+i.Label)
	})
}
func (a *App) provider(i domain.Integration) (*providers.Client, error) {
	secret, e := a.Secret("integration-" + i.ID)
	if e != nil {
		return nil, fmt.Errorf("integration credentials are unavailable")
	}
	return providers.New(secret), nil
}
func (a *App) Statuses(ctx context.Context, id string) (map[string]string, error) {
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil {
		return nil, e
	}
	c, e := a.provider(i)
	if e != nil {
		return nil, e
	}
	return c.Statuses(ctx, i)
}
func (a *App) SyncAll(ctx context.Context) {
	is, e := storage.List[domain.Integration](ctx, a.Store.DB, "integrations")
	if e != nil {
		return
	}
	for _, i := range is {
		if i.Enabled && (i.Provider == "linear" || i.Provider == "jira") {
			interval := i.PollInterval
			if interval == 0 {
				interval = 60
			}
			last, e := time.Parse(time.RFC3339Nano, i.LastAttempt)
			if e != nil {
				last, _ = time.Parse(time.RFC3339Nano, i.LastSync)
			}
			if i.WebhookPending || time.Since(last) >= time.Duration(interval)*time.Second {
				a.Sync(ctx, i.ID)
			}
		}
	}
}
func (a *App) Sync(ctx context.Context, id string) error {
	a.IntegrationOps.Lock()
	defer a.IntegrationOps.Unlock()
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil {
		return e
	}
	if !i.Enabled {
		return fmt.Errorf("integration is disabled")
	}
	client, e := a.provider(i)
	if e != nil {
		return e
	}
	started := time.Now().UTC()
	i.LastAttempt = started.Format(time.RFC3339Nano)
	since := i.LastSync
	full, e := time.Parse(time.RFC3339Nano, i.LastFullSync)
	fullSync := e != nil || time.Since(full) > 24*time.Hour
	if fullSync {
		since = ""
	} else if t, e := time.Parse(time.RFC3339Nano, since); e == nil {
		since = t.Add(-2 * time.Minute).Format(time.RFC3339)
	}
	issues, err := client.Pull(ctx, i, since)
	if err != nil {
		i.Error = err.Error()
		i.Touch()
		a.save(ctx, i, i.ID, "sync.failed", i.Error)
		return err
	}
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		current, e := storage.Get[domain.Integration](ctx, q, "integrations", id)
		if e != nil {
			return e
		}
		if current.Revision != i.Revision {
			return fmt.Errorf("integration changed during synchronization; retry with current settings")
		}
		existing, e := storage.List[domain.Issue](ctx, q, "issues")
		if e != nil {
			return e
		}
		byKey := map[string]domain.Issue{}
		for _, x := range existing {
			if x.IntegrationID == id {
				byKey[x.ExternalID] = x
			}
		}
		changed := 0
		for _, issue := range issues {
			oldIssue, wasKnown := byKey[issue.ExternalID]
			if wasKnown && oldIssue.SourceUpdatedAt != "" && issue.SourceUpdatedAt != "" {
				oldTime, oe := time.Parse(time.RFC3339Nano, oldIssue.SourceUpdatedAt)
				newTime, ne := time.Parse(time.RFC3339Nano, issue.SourceUpdatedAt)
				if oe == nil && ne == nil && newTime.Before(oldTime) {
					continue
				}
			}
			if old, ok := byKey[issue.ExternalID]; ok {
				issue.Meta = old.Meta
				issue.ProjectID = old.ProjectID
				issue.ParentID = old.ParentID
				issue.Acceptance = old.Acceptance
				if issue.SourceUpdatedAt == old.SourceUpdatedAt && issue.Status == old.Status {
					continue
				}
				issue.Touch()
			} else {
				issue.Meta = domain.NewMeta()
			}
			changed++
			if e = persist(ctx, q, issue); e != nil {
				return e
			}
			if e = a.reconcileIntake(ctx, q, current, oldIssue, issue, wasKnown); e != nil {
				return e
			}
			if issue.Status == "canceled" {
				runs, e := storage.List[domain.Run](ctx, q, "runs")
				if e != nil {
					return e
				}
				for _, run := range runs {
					if run.Task.IssueID != issue.ID || run.State != "running" {
						continue
					}
					key := "canceled:" + issue.ID + ":" + run.ID
					var exists int
					if e = q.QueryRowContext(ctx, "SELECT count(*) FROM actions WHERE fingerprint=?", key).Scan(&exists); e != nil {
						return e
					}
					if exists > 0 {
						continue
					}
					notice := domain.Action{Meta: domain.NewMeta(), Kind: "notice", EntityID: run.ID, State: "attention", Fingerprint: key, Body: issue.Identifier + " was canceled in " + i.Label + " while its worker is running. Inspect the session and cancel the run if its work is no longer needed."}
					if e = persist(ctx, q, notice); e != nil {
						return e
					}
					if e = storage.Event(ctx, q, run.ID, "issue.canceled", notice.Body); e != nil {
						return e
					}
				}
			}
		}
		current.WebhookPending = false
		current.LastAttempt = i.LastAttempt
		current.LastSync = started.Format(time.RFC3339Nano)
		if fullSync {
			current.LastFullSync = current.LastSync
		}
		current.Error = ""
		current.Touch()
		if e = persist(ctx, q, current); e != nil {
			return e
		}
		kind := "sync.completed"
		if changed > 0 {
			kind = "sync.changed"
		}
		return storage.Event(ctx, q, id, kind, fmt.Sprintf("Synchronized %d issues (%d changed) from %s", len(issues), changed, i.Label))
	})
}
func (a *App) TrackerAction(ctx context.Context, id, kind, body, key string) (domain.Action, error) {
	i, e := storage.Get[domain.Issue](ctx, a.Store.DB, "issues", id)
	if e != nil {
		return domain.Action{}, e
	}
	if i.Source == "native" {
		return domain.Action{}, fmt.Errorf("issue is not linked to a tracker")
	}
	if kind != "tracker.comment" && kind != "tracker.status" {
		return domain.Action{}, fmt.Errorf("unsupported tracker action")
	}
	if body == "" || key == "" {
		return domain.Action{}, fmt.Errorf("body and idempotency key are required")
	}
	return a.enqueue(ctx, domain.Action{Meta: domain.NewMeta(), Kind: kind, EntityID: id, IntegrationID: i.IntegrationID, State: "pending", Body: body, Fingerprint: key})
}
func (a *App) enqueue(ctx context.Context, action domain.Action) (domain.Action, error) {
	a.ActionOps.Lock()
	defer a.ActionOps.Unlock()
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		// Recheck ownership inside the write transaction: the workspace may have
		// been removed since the request first read its issue or run.
		if strings.HasPrefix(action.Kind, "tracker.") {
			if _, e := storage.Get[domain.Issue](ctx, q, "issues", action.EntityID); e != nil {
				return e
			}
			if _, e := storage.Get[domain.Integration](ctx, q, "integrations", action.IntegrationID); e != nil {
				return e
			}
		} else if action.Kind == "agent.followup" {
			if _, e := storage.Get[domain.Run](ctx, q, "runs", action.EntityID); e != nil {
				return e
			}
		}
		all, e := storage.List[domain.Action](ctx, q, "actions")
		if e != nil {
			return e
		}
		for _, old := range all {
			if old.Fingerprint == action.Fingerprint {
				if old.Kind != action.Kind || old.EntityID != action.EntityID || old.Body != action.Body {
					return fmt.Errorf("idempotency key already used for another action")
				}
				action = old
				return nil
			}
		}
		if e = persist(ctx, q, action); e != nil {
			return e
		}
		return storage.Event(ctx, q, action.EntityID, "action.queued", "Queued "+action.Kind)
	})
	return action, err
}
func (a *App) Followup(ctx context.Context, runID, body, key string) (domain.Action, error) {
	if body == "" || key == "" {
		return domain.Action{}, fmt.Errorf("message and idempotency key required")
	}
	if _, e := storage.Get[domain.Run](ctx, a.Store.DB, "runs", runID); e != nil {
		return domain.Action{}, e
	}
	return a.enqueue(ctx, domain.Action{Meta: domain.NewMeta(), Kind: "agent.followup", EntityID: runID, State: "pending", Body: body, Fingerprint: key})
}
func (a *App) DeliverActions(ctx context.Context) {
	a.ActionOps.Lock()
	defer a.ActionOps.Unlock()
	all, e := storage.List[domain.Action](ctx, a.Store.DB, "actions")
	if e != nil {
		return
	}
	for _, action := range all {
		if action.State != "pending" {
			continue
		}
		if strings.HasPrefix(action.Kind, "tracker.") {
			i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", action.IntegrationID)
			if e != nil || !i.Enabled {
				continue
			}
			issue, e := storage.Get[domain.Issue](ctx, a.Store.DB, "issues", action.EntityID)
			if e != nil {
				continue
			}
			client, e := a.provider(i)
			if e != nil {
				continue
			}
			// Record intent before crossing the network. A crash/timeout leaves an uncertain action,
			// never an automatically repeated comment.
			action.State = "delivering"
			action.Touch()
			if e = a.save(ctx, action, action.ID, "action.delivering", action.Kind); e != nil {
				continue
			}
			if action.Kind == "tracker.comment" {
				e = client.Comment(ctx, i, issue, action.Body)
			} else {
				e = client.Transition(ctx, i, issue, action.Body)
			}
			if e != nil {
				action.State = "uncertain"
				action.Error = e.Error() + ". Check the tracker before retrying."
			} else {
				action.State = "delivered"
				action.Error = ""
			}
			action.Touch()
			a.save(ctx, action, action.ID, "action."+action.State, action.Error)
			continue
		}
		if action.Kind == "orchestrator.followup" {
			a.deliverOrchestrator(ctx, action)
		}
		if action.Kind == "agent.followup" {
			a.Operations.Lock()
			a.deliverFollowup(ctx, &action)
			a.Operations.Unlock()
		}
	}
}
func (a *App) deliverFollowup(ctx context.Context, action *domain.Action) {
	current, e := storage.Get[domain.Action](ctx, a.Store.DB, "actions", action.ID)
	if e != nil || current.State != "pending" {
		return
	}
	*action = current
	r, e := storage.Get[domain.Run](ctx, a.Store.DB, "runs", action.EntityID)
	if e != nil || r.State == "completed" || r.State == "canceled" {
		return
	}
	s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
	if e != nil {
		return
	}
	if r.Repairs >= 2 {
		action.State = "attention"
		action.Error = "Automatic repair limit reached"
		action.Touch()
		a.save(ctx, *action, action.ID, "action.attention", action.Error)
		return
	}
	// Only Claude's completed-turn hook establishes readiness. Any attached client
	// (including a view-only browser) suspends automatic delivery to avoid racing input.
	if s.Harness.ID != "claude" || s.State != "idle" || s.SignalSource != "native-hook" {
		return
	}
	at, e := time.Parse(time.RFC3339Nano, s.SignalAt)
	if e != nil || time.Since(at) < 2*time.Second {
		return
	}
	i, e := a.Launcher.Inspect(ctx, s.Handle)
	if e != nil || !i.Exists || i.Dead || i.Attached > 0 {
		return
	}
	action.State = "delivering"
	action.Touch()
	r.Repairs++
	r.Touch()
	s.State = "working"
	s.SignalSource = "runner"
	s.SignalAt = domain.Now()
	s.Touch()
	if e = a.Store.Tx(ctx, func(q storage.Queryer) error {
		if err := persist(ctx, q, *action); err != nil {
			return err
		}
		if err := persist(ctx, q, r); err != nil {
			return err
		}
		return persist(ctx, q, s)
	}); e != nil {
		return
	}
	if e = a.Launcher.Send(ctx, s.Handle, action.Body); e != nil {
		action.State = "uncertain"
		action.Error = e.Error() + ". Inspect the terminal before retrying."
	} else {
		action.State = "delivered"
		action.Error = ""
	}
	action.Touch()
	a.save(ctx, *action, action.ID, "action."+action.State, "Worker follow-up "+action.State)
}
func (a *App) ActionDecision(ctx context.Context, id, decision string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	action, e := storage.Get[domain.Action](ctx, a.Store.DB, "actions", id)
	if e != nil {
		return e
	}
	if action.State == "delivered" || action.State == "dismissed" {
		return fmt.Errorf("action is already settled")
	}
	if action.State == "delivering" {
		return fmt.Errorf("delivery is in progress; wait for its result")
	}
	switch decision {
	case "dismiss":
		action.State = "dismissed"
	case "confirmed":
		action.State = "delivered"
	case "retry":
		if action.Kind == "agent.followup" {
			return fmt.Errorf("send the follow-up explicitly")
		}
		action.State = "pending"
	case "send":
		var r domain.Run
		var s domain.Session
		if action.Kind == "agent.followup" {
			r, e = storage.Get[domain.Run](ctx, a.Store.DB, "runs", action.EntityID)
			if e != nil {
				return e
			}
			if r.State != "running" {
				return fmt.Errorf("run is not active")
			}
			s, e = storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
		} else if action.Kind == "orchestrator.followup" {
			s, e = storage.Get[domain.Session](ctx, a.Store.DB, "sessions", action.EntityID)
		} else {
			return fmt.Errorf("not an agent action")
		}
		if e != nil {
			return e
		}

		if !live(s.State) {
			return fmt.Errorf("session is not live")
		}
		action.State = "delivering"
		action.Touch()
		if e = a.save(ctx, action, action.ID, "action.delivering", "Sending follow-up"); e != nil {
			return e
		}
		if e = a.Launcher.Send(ctx, s.Handle, action.Body); e != nil {
			action.State = "uncertain"
			action.Error = e.Error()
			a.save(ctx, action, action.ID, "action.uncertain", action.Error)
			return e
		}
		action.State = "delivered"
		if r.ID != "" {
			r.Repairs++
			r.Touch()
			a.save(ctx, r, r.ID, "run.followup", "Sent requested follow-up")
		}
		s.State = "working"
		s.SignalSource = "user"
		s.Touch()
		a.save(ctx, s, s.ID, "session.working", "Follow-up sent")
	default:
		return fmt.Errorf("unknown action decision")
	}
	action.Error = ""
	action.Touch()
	return a.save(ctx, action, action.ID, "action."+action.State, "Action "+action.State)
}
func (a *App) ObserveChanges(ctx context.Context) {
	a.ChangesOps.Lock()
	defer a.ChangesOps.Unlock()
	runs, e := storage.List[domain.Run](ctx, a.Store.DB, "runs")
	if e != nil {
		return
	}
	for _, r := range runs {
		if r.State == "queued" || r.State == "preparing" || r.State == "canceled" || r.State == "completed" {
			continue
		}
		allMerged := len(r.Worktrees) > 0
		for _, w := range r.Worktrees {
			repo, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", w.RepositoryID)
			if e != nil {
				allMerged = false
				continue
			}
			i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", a.RepositoryAccount(ctx, repo))
			if e != nil || !i.Enabled {
				allMerged = false
				continue
			}
			client, e := a.provider(i)
			if e != nil {
				allMerged = false
				continue
			}
			change, e := client.Observe(ctx, i, repo, r)
			changes, _ := storage.List[domain.ChangeRequest](ctx, a.Store.DB, "changes")
			var old domain.ChangeRequest
			for _, x := range changes {
				if x.RunID == r.ID && x.RepositoryID == repo.ID {
					old = x
				}
			}
			if e != nil {
				allMerged = false
				if old.ID != "" {
					old.Error = e.Error()
					old.Touch()
					a.save(ctx, old, old.ID, "change.error", old.Error)
				}
				continue
			}
			if change.State == "missing" {
				allMerged = false
				continue
			}
			if old.ID == "" {
				change.Meta = domain.NewMeta()
			} else {
				change.Meta = old.Meta
				change.Touch()
			}
			if old.ID == "" || old.State != change.State || old.Checks != change.Checks || old.HeadSHA != change.HeadSHA || old.Error != "" || !reflect.DeepEqual(old.Feedback, change.Feedback) {
				a.save(ctx, change, change.ID, "change.observed", change.Title+": "+change.State+" (checks "+change.Checks+")")
			}
			if change.State != "merged" {
				allMerged = false
			}
			if change.State == "open" {
				a.localIssueStatus(ctx, r.Task.IssueID, "in_review")
				for _, f := range change.Feedback {
					hash := sha256.Sum256([]byte(f.Body))
					key := "feedback:" + change.ID + ":" + f.ID + ":" + hex.EncodeToString(hash[:8])
					a.Followup(ctx, r.ID, "Review this provider feedback for the approved task. Do not expand scope.\n\n"+f.Body+"\n"+f.URL, key)
				}
			}
		}
		if allMerged {
			a.RunAction(ctx, r.ID, "complete")
		}
	}
}
func (a *App) CreateChange(ctx context.Context, runID, repoID, title, body string) (domain.ChangeRequest, error) {
	a.ChangesOps.Lock()
	defer a.ChangesOps.Unlock()
	r, e := storage.Get[domain.Run](ctx, a.Store.DB, "runs", runID)
	if e != nil {
		return domain.ChangeRequest{}, e
	}
	if r.State != "running" {
		return domain.ChangeRequest{}, fmt.Errorf("run must be active")
	}
	if !slices.Contains(r.Task.RepositoryIDs, repoID) {
		return domain.ChangeRequest{}, fmt.Errorf("repository is outside the approved task")
	}
	repo, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", repoID)
	if e != nil {
		return domain.ChangeRequest{}, e
	}
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", a.RepositoryAccount(ctx, repo))
	if e != nil {
		return domain.ChangeRequest{}, fmt.Errorf("connect a Git provider to this repository")
	}
	client, e := a.provider(i)
	if e != nil {
		return domain.ChangeRequest{}, e
	}
	c, e := client.Create(ctx, i, repo, r, title, body)
	if e != nil {
		return c, e
	}
	existing, _ := storage.List[domain.ChangeRequest](ctx, a.Store.DB, "changes")
	c.Meta = domain.NewMeta()
	for _, x := range existing {
		if x.RunID == runID && x.RepositoryID == repoID {
			c.Meta = x.Meta
			c.Touch()
		}
	}
	return c, a.save(ctx, c, c.ID, "change.created", "Opened "+c.URL)
}
func (a *App) notify(ctx context.Context, id, message string) {
	if a.Config.WebhookURL == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"id": id, "message": message})
	req, e := http.NewRequestWithContext(ctx, "POST", a.Config.WebhookURL, bytes.NewReader(body))
	if e != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	res, e := client.Do(req)
	if e == nil {
		res.Body.Close()
	}
}

func (a *App) RepositoryAccount(ctx context.Context, r domain.Repository) string {
	id := r.IntegrationID
	if id == "" {
		w, e := storage.Get[domain.Workspace](ctx, a.Store.DB, "workspaces", r.WorkspaceID)
		if e != nil {
			return ""
		}
		if r.Provider == "github" {
			id = w.GitHubAccountID
		} else if r.Provider == "gitlab" {
			id = w.GitLabAccountID
		}
	}
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", id)
	if e != nil || !i.Enabled || i.WorkspaceID != r.WorkspaceID || (i.Provider != "github" && i.Provider != "gitlab") {
		return ""
	}
	canonical, _, _, e := repos.Remote(r.Remote)
	if e != nil {
		return ""
	}
	host := i.Provider + ".com"
	if i.BaseURL != "" {
		u, e := url.Parse(i.BaseURL)
		if e != nil {
			return ""
		}
		host = strings.TrimPrefix(u.Hostname(), "api.")
	}
	if strings.Split(canonical, "/")[0] != strings.ToLower(host) {
		return ""
	}
	return id
}

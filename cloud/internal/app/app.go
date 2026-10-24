package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

type Config struct {
	DataDir              string                  `json:"-"`
	Address              string                  `json:"address"`
	AllowedHosts         []string                `json:"allowedHosts"`
	PublicURL            string                  `json:"publicUrl"`
	MaxWorkers           int                     `json:"maxWorkers"`
	MaxOrchestrators     int                     `json:"maxOrchestrators"`
	RetentionDays        int                     `json:"retentionDays"`
	Profiles             []domain.HarnessProfile `json:"profiles"`
	WebhookURL           string                  `json:"webhookUrl"`
	ExecutionEnvironment string                  `json:"executionEnvironment"`
}

func LoadConfig(dir string) (Config, error) {
	return loadConfig(dir, "isolated")
}

// Local starts reuse host CLI authentication; explicit settings still take precedence.
func LoadLocalConfig(dir string) (Config, error) {
	return loadConfig(dir, "host")
}

func loadConfig(dir, environment string) (Config, error) {
	if dir == "" {
		var err error
		dir, err = DefaultDataDir()
		if err != nil {
			return Config{}, err
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Config{}, err
	}
	c := Config{DataDir: abs, Address: "127.0.0.1:4780", AllowedHosts: []string{"127.0.0.1:4780", "localhost:4780", "127.0.0.1:5174", "localhost:5174"}, MaxWorkers: 3, MaxOrchestrators: 1, RetentionDays: 7, ExecutionEnvironment: environment}
	b, err := os.ReadFile(filepath.Join(abs, "settings.json"))
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	if err != nil && !os.IsNotExist(err) {
		return c, fmt.Errorf("read settings %s: %w", filepath.Join(abs, "settings.json"), err)
	}
	if v := os.Getenv("AUTOPILOT_LISTEN"); v != "" {
		c.Address = v
	}
	if v := os.Getenv("AUTOPILOT_ALLOWED_HOSTS"); v != "" {
		c.AllowedHosts = strings.Split(v, ",")
	}
	if v := os.Getenv("AUTOPILOT_PUBLIC_URL"); v != "" {
		c.PublicURL = v
	}
	if v := os.Getenv("AUTOPILOT_EXECUTION_ENVIRONMENT"); v != "" {
		c.ExecutionEnvironment = v
	}
	if c.ExecutionEnvironment != "isolated" && c.ExecutionEnvironment != "host" {
		return c, fmt.Errorf("executionEnvironment must be isolated or host")
	}
	if c.ExecutionEnvironment == "host" {
		home, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(home) {
			return c, fmt.Errorf("host execution requires an absolute user home directory")
		}
	}
	if c.MaxWorkers < 1 || c.MaxOrchestrators < 1 || c.RetentionDays < 1 {
		return c, fmt.Errorf("concurrency and retention must be positive")
	}
	return c, nil
}

type App struct {
	Config         Config
	Store          *storage.Store
	Plugins        *plugins.Registry
	Launcher       plugins.Launcher
	Operations     sync.Mutex
	IntegrationOps sync.Mutex
	ChangesOps     sync.Mutex
	ActionOps      sync.Mutex
	CSRF           string
	AdminToken     string
	APIURL         string
}

func New(cfg Config) (*App, error) {
	for _, d := range []string{cfg.DataDir, filepath.Join(cfg.DataDir, "secrets"), filepath.Join(cfg.DataDir, "agent-home"), filepath.Join(cfg.DataDir, "sessions"), filepath.Join(cfg.DataDir, "runs"), filepath.Join(cfg.DataDir, "workspaces"), filepath.Join(cfg.DataDir, "tools", "bin")} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return nil, err
		}
	}
	s, err := storage.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	var overrides []domain.HarnessProfile
	if raw, e := os.ReadFile(filepath.Join(cfg.DataDir, "profiles.json")); e == nil {
		if e = json.Unmarshal(raw, &overrides); e != nil {
			s.Close()
			return nil, e
		}
	} else if !os.IsNotExist(e) {
		s.Close()
		return nil, e
	}
	r, err := plugins.New(append(cfg.Profiles, overrides...))
	if err != nil {
		s.Close()
		return nil, err
	}
	a := &App{Config: cfg, Store: s, Plugins: r}
	a.CSRF, err = a.Secret("csrf")
	if os.IsNotExist(err) {
		a.CSRF = randomToken()
		err = a.SetSecret("csrf", a.CSRF)
	}
	if err != nil {
		s.Close()
		return nil, err
	}
	a.AdminToken, err = a.Secret("admin")
	if os.IsNotExist(err) {
		a.AdminToken = randomToken()
		err = a.SetSecret("admin", a.AdminToken)
	}
	if err != nil {
		s.Close()
		return nil, err
	}
	a.APIURL = "http://" + cfg.Address
	if strings.HasPrefix(cfg.Address, "0.0.0.0:") {
		a.APIURL = "http://127.0.0.1:" + strings.TrimPrefix(cfg.Address, "0.0.0.0:")
	}
	return a, nil
}
func randomToken() string { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func validSecretName(s string) bool {
	return s != "" && filepath.Base(s) == s && s != "." && s != ".." && !strings.ContainsAny(s, "/\\")
}
func (a *App) Secret(name string) (string, error) {
	if !validSecretName(name) {
		return "", fmt.Errorf("invalid secret reference")
	}
	b, e := os.ReadFile(filepath.Join(a.Config.DataDir, "secrets", name))
	return string(b), e
}
func (a *App) SetSecret(name, value string) error {
	if !validSecretName(name) {
		return fmt.Errorf("invalid secret reference")
	}
	return os.WriteFile(filepath.Join(a.Config.DataDir, "secrets", name), []byte(value), 0600)
}

func persist(ctx context.Context, q storage.Queryer, v any) error {
	switch x := v.(type) {
	case domain.QueueEntry:
		return storage.Save(ctx, q, "queue", x.ID, x, "workspace_id", x.WorkspaceID, "issue_id", x.IssueID, "fingerprint", x.Fingerprint)
	case domain.Workspace:
		return storage.Save(ctx, q, "workspaces", x.ID, x, "root", x.Root)
	case domain.Repository:
		return storage.Save(ctx, q, "repositories", x.ID, x, "workspace_id", x.WorkspaceID, "path", x.Path)
	case domain.Worktree:
		return storage.Save(ctx, q, "worktrees", x.ID, x, "workspace_id", x.WorkspaceID, "repository_id", x.RepositoryID, "path", x.Path, "request_key", storage.Null(x.RequestKey))
	case domain.Project:
		return storage.Save(ctx, q, "projects", x.ID, x, "workspace_id", x.WorkspaceID)
	case domain.Issue:
		key := ""
		if x.ExternalID != "" {
			key = x.IntegrationID + ":" + x.ExternalID
		}
		return storage.Save(ctx, q, "issues", x.ID, x, "workspace_id", x.WorkspaceID, "project_id", storage.Null(x.ProjectID), "parent_id", storage.Null(x.ParentID), "external_key", storage.Null(key))
	case domain.Comment:
		key := ""
		if x.ExternalID != "" {
			key = x.IssueID + ":" + x.ExternalID
		}
		return storage.Save(ctx, q, "comments", x.ID, x, "issue_id", x.IssueID, "external_key", storage.Null(key))
	case domain.Plan:
		return storage.Save(ctx, q, "plans", x.ID, x, "workspace_id", x.WorkspaceID, "issue_id", storage.Null(x.IssueID))
	case domain.Execution:
		return storage.Save(ctx, q, "executions", x.ID, x, "plan_id", x.PlanID, "plan_revision", x.PlanRevision, "request_key", x.RequestKey)
	case domain.Run:
		active := 1
		if x.State == "completed" || x.State == "canceled" {
			active = 0
		}
		return storage.Save(ctx, q, "runs", x.ID, x, "execution_id", x.ExecutionID, "task_id", x.Task.ID, "issue_id", storage.Null(x.Task.IssueID), "active", active)
	case domain.Session:
		return storage.Save(ctx, q, "sessions", x.ID, x, "workspace_id", x.WorkspaceID, "run_id", storage.Null(x.RunID), "handle", x.Handle)
	case domain.Integration:
		return storage.Save(ctx, q, "integrations", x.ID, x, "workspace_id", x.WorkspaceID)
	case domain.ChangeRequest:
		return storage.Save(ctx, q, "changes", x.ID, x, "run_id", x.RunID, "repository_id", x.RepositoryID)
	case domain.Action:
		return storage.Save(ctx, q, "actions", x.ID, x, "fingerprint", x.Fingerprint)
	}
	return fmt.Errorf("unsupported record %T", v)
}
func (a *App) save(ctx context.Context, v any, id, kind, msg string) error {
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		if err := persist(ctx, q, v); err != nil {
			return err
		}
		return storage.Event(ctx, q, id, kind, msg)
	})
}

type Snapshot struct {
	Queue        []domain.QueueEntry    `json:"queue"`
	Worktrees    []domain.Worktree      `json:"worktrees"`
	CSRF         string                 `json:"csrf"`
	Workspaces   []domain.Workspace     `json:"workspaces"`
	Repositories []domain.Repository    `json:"repositories"`
	Projects     []domain.Project       `json:"projects"`
	Issues       []domain.Issue         `json:"issues"`
	Comments     []domain.Comment       `json:"comments"`
	Plans        []domain.Plan          `json:"plans"`
	Executions   []domain.Execution     `json:"executions"`
	Runs         []domain.Run           `json:"runs"`
	Sessions     []domain.Session       `json:"sessions"`
	Integrations []domain.Integration   `json:"integrations"`
	Changes      []domain.ChangeRequest `json:"changes"`
	Actions      []domain.Action        `json:"actions"`
}

func (a *App) Snapshot(ctx context.Context) (Snapshot, error) {
	s := Snapshot{CSRF: a.CSRF}
	err := a.Store.View(ctx, func(q storage.Queryer) error {
		var e error
		if s.Queue, e = storage.List[domain.QueueEntry](ctx, q, "queue"); e != nil {
			return e
		}
		if s.Worktrees, e = storage.List[domain.Worktree](ctx, q, "worktrees"); e != nil {
			return e
		}
		if s.Workspaces, e = storage.List[domain.Workspace](ctx, q, "workspaces"); e != nil {
			return e
		}
		if s.Repositories, e = storage.List[domain.Repository](ctx, q, "repositories"); e != nil {
			return e
		}
		if s.Projects, e = storage.List[domain.Project](ctx, q, "projects"); e != nil {
			return e
		}
		if s.Issues, e = storage.List[domain.Issue](ctx, q, "issues"); e != nil {
			return e
		}
		if s.Comments, e = storage.List[domain.Comment](ctx, q, "comments"); e != nil {
			return e
		}
		if s.Plans, e = storage.List[domain.Plan](ctx, q, "plans"); e != nil {
			return e
		}
		if s.Executions, e = storage.List[domain.Execution](ctx, q, "executions"); e != nil {
			return e
		}
		if s.Runs, e = storage.List[domain.Run](ctx, q, "runs"); e != nil {
			return e
		}
		if s.Sessions, e = storage.List[domain.Session](ctx, q, "sessions"); e != nil {
			return e
		}
		if s.Integrations, e = storage.List[domain.Integration](ctx, q, "integrations"); e != nil {
			return e
		}
		if s.Changes, e = storage.List[domain.ChangeRequest](ctx, q, "changes"); e != nil {
			return e
		}
		s.Actions, e = storage.List[domain.Action](ctx, q, "actions")
		return e
	})
	if err == nil {
		projectWorkflow(&s)
	}
	return s, err
}

func (a *App) CreateWorkspace(ctx context.Context, w domain.Workspace) (domain.Workspace, error) {
	w, err := a.prepareWorkspace(w)
	if err != nil {
		return w, err
	}
	return w, a.save(ctx, w, w.ID, "workspace.created", "Created workspace "+w.Name)
}
func (a *App) prepareWorkspace(w domain.Workspace) (domain.Workspace, error) {
	if strings.TrimSpace(w.Name) == "" {
		return w, fmt.Errorf("workspace name is required")
	}
	w.Meta = domain.NewMeta()
	if w.WorkerHarness == "" {
		w.WorkerHarness = "claude"
	}
	if w.OrchestratorHarness == "" {
		w.OrchestratorHarness = w.WorkerHarness
	}
	if _, err := a.Plugins.Profile(w.WorkerHarness); err != nil {
		return w, err
	}
	if _, err := a.Plugins.Profile(w.OrchestratorHarness); err != nil {
		return w, err
	}
	if w.Root == "" {
		w.Root = filepath.Join(a.Config.DataDir, "workspaces", w.ID)
		if err := os.MkdirAll(w.Root, 0700); err != nil {
			return w, err
		}
	}
	root, err := repos.CanonicalPath(w.Root)
	if err != nil {
		return w, err
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return w, fmt.Errorf("workspace root must be a directory")
	}
	w.Root = root
	return w, nil
}
func (a *App) SaveWorkspace(ctx context.Context, id string, w domain.Workspace) (domain.Workspace, error) {
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		old, e := storage.Get[domain.Workspace](ctx, q, "workspaces", id)
		if e != nil {
			return e
		}
		if old.Revision != w.Revision {
			return fmt.Errorf("workspace changed; refresh and retry")
		}
		if strings.TrimSpace(w.Name) == "" {
			return fmt.Errorf("name is required")
		}
		if _, e = a.Plugins.Profile(w.WorkerHarness); e != nil {
			return e
		}
		if _, e = a.Plugins.Profile(w.OrchestratorHarness); e != nil {
			return e
		}
		for provider, id := range map[string]string{"github": w.GitHubAccountID, "gitlab": w.GitLabAccountID} {
			if id != "" {
				i, e := storage.Get[domain.Integration](ctx, q, "integrations", id)
				if e != nil || i.Provider != provider || i.WorkspaceID != old.ID {
					return fmt.Errorf("choose an account in this workspace")
				}
			}
		}
		old.GitHubAccountID = w.GitHubAccountID
		old.GitLabAccountID = w.GitLabAccountID
		old.Name = w.Name
		old.WorkerHarness = w.WorkerHarness
		old.OrchestratorHarness = w.OrchestratorHarness
		old.Touch()
		w = old
		return persist(ctx, q, w)
	})
	return w, err
}
func (a *App) AddRepository(ctx context.Context, r domain.Repository, clone bool) (domain.Repository, error) {
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	w, err := storage.Get[domain.Workspace](ctx, a.Store.DB, "workspaces", r.WorkspaceID)
	if err != nil {
		return r, err
	}
	if clone {
		r.Path, err = repos.Clone(ctx, w.Root, r.Name, r.Remote)
		if err != nil {
			return r, err
		}
	}
	r, err = inspectRepository(ctx, r)
	if err != nil {
		return r, err
	}
	if r.IntegrationID != "" {
		i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", r.IntegrationID)
		if e != nil {
			return r, e
		}
		if i.WorkspaceID != r.WorkspaceID || i.Provider != r.Provider {
			return r, fmt.Errorf("repository integration must match its workspace and provider")
		}
	}
	if err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		if e := uniqueRepository(ctx, q, r); e != nil {
			return e
		}
		if e := persist(ctx, q, r); e != nil {
			return e
		}
		return storage.Event(ctx, q, r.ID, "repository.added", "Registered "+r.Name)
	}); err != nil {
		return r, err
	}
	return r, a.DiscoverWorktrees(ctx, r.ID)
}
func (a *App) CreateProject(ctx context.Context, p domain.Project) (domain.Project, error) {
	if strings.TrimSpace(p.Name) == "" {
		return p, fmt.Errorf("project name is required")
	}
	p.Meta = domain.NewMeta()
	return p, a.save(ctx, p, p.ID, "project.created", "Created project "+p.Name)
}

func (a *App) ConnectRepository(ctx context.Context, id string, revision int, integrationID string) (domain.Repository, error) {
	var repo domain.Repository
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		var e error
		repo, e = storage.Get[domain.Repository](ctx, q, "repositories", id)
		if e != nil {
			return e
		}
		if repo.Revision != revision {
			return fmt.Errorf("repository changed; refresh and retry")
		}
		canonical, detected, _, e := repos.Remote(repo.Remote)
		if e != nil {
			return e
		}
		repo.Provider = detected
		if integrationID != "" {
			i, e := storage.Get[domain.Integration](ctx, q, "integrations", integrationID)
			if e != nil {
				return e
			}
			if i.WorkspaceID != repo.WorkspaceID || (i.Provider != "github" && i.Provider != "gitlab") {
				return fmt.Errorf("choose a Git provider connection in this workspace")
			}
			host := i.Provider + ".com"
			if i.BaseURL != "" {
				u, e := url.Parse(i.BaseURL)
				if e != nil {
					return e
				}
				host = strings.TrimPrefix(u.Hostname(), "api.")
			}
			if strings.Split(canonical, "/")[0] != strings.ToLower(host) {
				return fmt.Errorf("provider host does not match the repository remote")
			}
			repo.Provider = i.Provider
		}
		repo.IntegrationID = integrationID
		repo.Touch()
		if e = persist(ctx, q, repo); e != nil {
			return e
		}
		return storage.Event(ctx, q, repo.ID, "repository.connected", "Updated Git provider connection")
	})
	return repo, err
}
func (a *App) CreateIssue(ctx context.Context, i domain.Issue) (domain.Issue, error) {
	i.Meta = domain.NewMeta()
	i.Source = "native"
	i.ExternalID = ""
	i.IntegrationID = ""
	i.ExternalURL = ""
	i.Status = "backlog"
	i.Priority = 0
	i.PlanningSessionID = ""
	i.WorkflowState = ""
	i.WorkflowDetail = ""
	i.PlanIDs = nil
	if i.Labels == nil {
		i.Labels = []string{}
	}
	if err := i.Validate(); err != nil {
		return i, err
	}
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		if err := validateIssueRefs(ctx, q, i); err != nil {
			return err
		}
		var n int
		if err := q.QueryRowContext(ctx, `INSERT INTO counters(name,value) VALUES('issue',1) ON CONFLICT(name) DO UPDATE SET value=value+1 RETURNING value`).Scan(&n); err != nil {
			return err
		}
		i.Identifier = fmt.Sprintf("AP-%d", n)
		if err := persist(ctx, q, i); err != nil {
			return err
		}
		return storage.Event(ctx, q, i.ID, "issue.created", "Created "+i.Identifier)
	})
	return i, err
}
func validateIssueRefs(ctx context.Context, q storage.Queryer, i domain.Issue) error {
	if _, err := storage.Get[domain.Workspace](ctx, q, "workspaces", i.WorkspaceID); err != nil {
		return err
	}
	if i.ProjectID != "" {
		p, err := storage.Get[domain.Project](ctx, q, "projects", i.ProjectID)
		if err != nil {
			return err
		}
		if p.WorkspaceID != i.WorkspaceID {
			return fmt.Errorf("project belongs to a different workspace")
		}
	}
	if i.ParentID != "" {
		p, err := storage.Get[domain.Issue](ctx, q, "issues", i.ParentID)
		if err != nil {
			return err
		}
		if p.WorkspaceID != i.WorkspaceID || p.ID == i.ID {
			return fmt.Errorf("invalid parent issue")
		}
		for p.ParentID != "" {
			if p.ParentID == i.ID {
				return fmt.Errorf("issue parent cycle")
			}
			p, err = storage.Get[domain.Issue](ctx, q, "issues", p.ParentID)
			if err != nil {
				return err
			}
		}
	}
	return nil
}
func (a *App) UpdateIssue(ctx context.Context, id string, i domain.Issue) (domain.Issue, error) {
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		old, e := storage.Get[domain.Issue](ctx, q, "issues", id)
		if e != nil {
			return e
		}
		if old.Revision != i.Revision {
			return fmt.Errorf("issue changed; refresh and retry")
		}
		if old.Source != "native" {
			return fmt.Errorf("external issue fields are read-only; request a tracker transition instead")
		}
		old.Title = i.Title
		old.Description = i.Description
		old.Acceptance = i.Acceptance
		old.Priority = i.Priority
		old.Labels = i.Labels
		old.ProjectID = i.ProjectID
		old.ParentID = i.ParentID
		if e = old.Validate(); e != nil {
			return e
		}
		if e = validateIssueRefs(ctx, q, old); e != nil {
			return e
		}
		old.Touch()
		i = old
		if e = persist(ctx, q, i); e != nil {
			return e
		}
		return storage.Event(ctx, q, id, "issue.updated", "Updated "+i.Identifier)
	})
	return i, err
}
func (a *App) Comment(ctx context.Context, id, body string) (domain.Comment, error) {
	c := domain.Comment{Meta: domain.NewMeta(), IssueID: id, Body: strings.TrimSpace(body), Source: "local", Author: "You"}
	if c.Body == "" {
		return c, fmt.Errorf("comment cannot be empty")
	}
	return c, a.save(ctx, c, id, "comment.added", "Added a private note")
}
func (a *App) SavePlan(ctx context.Context, p domain.Plan) (domain.Plan, error) {
	p.State = "draft"
	for n := range p.Tasks {
		if p.Tasks[n].ID == "" {
			p.Tasks[n].ID = domain.ID()
		}
	}
	if e := p.Validate(); e != nil {
		return p, e
	}
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		if p.ID == "" {
			p.Meta = domain.NewMeta()
		} else {
			old, e := storage.Get[domain.Plan](ctx, q, "plans", p.ID)
			if e != nil {
				return e
			}
			if old.State != "draft" {
				return fmt.Errorf("approved plans are immutable; create a new plan")
			}
			if old.Revision != p.Revision {
				return fmt.Errorf("plan changed; refresh and retry")
			}
			if old.WorkspaceID != p.WorkspaceID {
				return fmt.Errorf("plan workspace cannot change")
			}
			p.Meta = old.Meta
			p.Touch()
		}
		if e := a.validatePlanRefs(ctx, q, p); e != nil {
			return e
		}
		if e := persist(ctx, q, p); e != nil {
			return e
		}
		for _, id := range append([]string{p.IssueID}, taskIssues(p.Tasks)...) {
			if id == "" {
				continue
			}
			issue, e := storage.Get[domain.Issue](ctx, q, "issues", id)
			if e != nil {
				return e
			}
			if issue.Source == "native" && (issue.Status == "backlog" || issue.Status == "ready") {
				issue.Status = "ready"
				issue.Touch()
				if e = persist(ctx, q, issue); e != nil {
					return e
				}
			}
		}
		return storage.Event(ctx, q, p.ID, "plan.proposed", "Plan ready for review: "+p.Title)
	})
	return p, err
}
func (a *App) validatePlanRefs(ctx context.Context, q storage.Queryer, p domain.Plan) error {
	if _, e := storage.Get[domain.Workspace](ctx, q, "workspaces", p.WorkspaceID); e != nil {
		return e
	}
	for _, id := range append([]string{p.IssueID}, taskIssues(p.Tasks)...) {
		if id == "" {
			continue
		}
		i, e := storage.Get[domain.Issue](ctx, q, "issues", id)
		if e != nil {
			return e
		}
		if i.WorkspaceID != p.WorkspaceID {
			return fmt.Errorf("issue belongs to another workspace")
		}
	}
	for _, t := range p.Tasks {
		if _, e := a.Plugins.Profile(t.Harness); e != nil {
			return e
		}
		seen := map[string]bool{}
		for _, id := range t.RepositoryIDs {
			if seen[id] {
				return fmt.Errorf("duplicate repository in task")
			}
			seen[id] = true
			r, e := storage.Get[domain.Repository](ctx, q, "repositories", id)
			if e != nil {
				return e
			}
			if r.WorkspaceID != p.WorkspaceID {
				return fmt.Errorf("task repository is outside its workspace")
			}
		}
	}
	return nil
}
func taskIssues(ts []domain.Task) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.IssueID)
	}
	return out
}
func (a *App) Approve(ctx context.Context, id string, revision int, key string) (domain.Execution, error) {
	var e domain.Execution
	if strings.TrimSpace(key) == "" {
		return e, fmt.Errorf("an idempotency key is required")
	}
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		var oldID string
		err := q.QueryRowContext(ctx, "SELECT id FROM executions WHERE request_key=?", key).Scan(&oldID)
		if err == nil {
			old, err := storage.Get[domain.Execution](ctx, q, "executions", oldID)
			if err != nil {
				return err
			}
			if old.PlanID != id || old.PlanRevision != revision {
				return fmt.Errorf("idempotency key belongs to a different approval")
			}
			e = old
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		p, err := storage.Get[domain.Plan](ctx, q, "plans", id)
		if err != nil {
			return err
		}
		if p.State != "draft" || p.Revision != revision {
			return fmt.Errorf("plan changed or was already approved; review its current revision")
		}
		if err = p.Validate(); err != nil {
			return err
		}
		if err = a.validatePlanRefs(ctx, q, p); err != nil {
			return err
		}
		e = domain.Execution{Meta: domain.NewMeta(), WorkspaceID: p.WorkspaceID, PlanID: id, PlanRevision: revision, Plan: p, State: "active", RequestKey: key}
		if err = persist(ctx, q, e); err != nil {
			return err
		}
		for _, t := range p.Tasks {
			profile, err := a.Plugins.Profile(t.Harness)
			if err != nil {
				return err
			}
			r := domain.Run{Meta: domain.NewMeta(), WorkspaceID: p.WorkspaceID, ExecutionID: e.ID, Task: t, Profile: profile, State: "queued", Worktrees: []domain.Worktree{}}
			if err = persist(ctx, q, r); err != nil {
				return err
			}
		}
		queued, err := storage.List[domain.QueueEntry](ctx, q, "queue")
		if err != nil {
			return err
		}
		for _, entry := range queued {
			if entry.State != "pending" {
				continue
			}
			for _, task := range p.Tasks {
				if entry.IssueID == task.IssueID || entry.IssueID == p.IssueID {
					entry.State = "planned"
					entry.Touch()
					if err = persist(ctx, q, entry); err != nil {
						return err
					}
					break
				}
			}
		}
		p.State = "approved"
		p.Touch()
		if err = persist(ctx, q, p); err != nil {
			return err
		}
		return storage.Event(ctx, q, e.ID, "plan.approved", "Approved "+p.Title)
	})
	return e, err
}

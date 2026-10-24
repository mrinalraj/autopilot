// Package domain contains the shared cloud/desktop vocabulary. It has no I/O.
package domain

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"time"
)

func ID() string  { b := make([]byte, 12); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

type Meta struct {
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func NewMeta() Meta    { n := Now(); return Meta{ID: ID(), Revision: 1, CreatedAt: n, UpdatedAt: n} }
func (m *Meta) Touch() { m.Revision++; m.UpdatedAt = Now() }

type Workspace struct {
	Meta
	GitHubAccountID     string `json:"githubAccountId"`
	GitLabAccountID     string `json:"gitlabAccountId"`
	Name                string `json:"name"`
	Root                string `json:"root"`
	WorkerHarness       string `json:"workerHarness"`
	OrchestratorHarness string `json:"orchestratorHarness"`
}
type Repository struct {
	Meta
	CommonDir     string   `json:"commonDir"`
	WorkspaceID   string   `json:"workspaceId"`
	Name          string   `json:"name"`
	Path          string   `json:"path"`
	Remote        string   `json:"remote"`
	DefaultBranch string   `json:"defaultBranch"`
	Provider      string   `json:"provider"`
	IntegrationID string   `json:"integrationId"`
	ProviderRepo  string   `json:"providerRepo"`
	Setup         []string `json:"setup"`
}
type Project struct {
	Meta
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

var Statuses = []string{"backlog", "ready", "in_progress", "in_review", "done", "canceled"}

type Issue struct {
	Meta
	PlanningSessionID string   `json:"planningSessionId"`
	WorkflowState     string   `json:"workflowState,omitempty"`
	WorkflowDetail    string   `json:"workflowDetail,omitempty"`
	PlanIDs           []string `json:"planIds"`
	ExternalStatusID  string   `json:"externalStatusId"`
	WorkspaceID       string   `json:"workspaceId"`
	ProjectID         string   `json:"projectId"`
	ParentID          string   `json:"parentId"`
	Identifier        string   `json:"identifier"`
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	Acceptance        string   `json:"acceptance"`
	Status            string   `json:"status"`
	Priority          int      `json:"priority"`
	Labels            []string `json:"labels"`
	Source            string   `json:"source"`
	IntegrationID     string   `json:"integrationId"`
	ExternalID        string   `json:"externalId"`
	ExternalURL       string   `json:"externalUrl"`
	ExternalStatus    string   `json:"externalStatus"`
	SourceUpdatedAt   string   `json:"sourceUpdatedAt"`
}

func (i Issue) Validate() error {
	if strings.TrimSpace(i.Title) == "" || len(i.Title) > 500 {
		return fmt.Errorf("issue title must contain 1–500 characters")
	}
	if !slices.Contains(Statuses, i.Status) {
		return fmt.Errorf("invalid issue status")
	}
	if i.Priority < 0 || i.Priority > 4 {
		return fmt.Errorf("priority must be 0–4")
	}
	return nil
}

type Comment struct {
	Meta
	IssueID    string `json:"issueId"`
	Body       string `json:"body"`
	Source     string `json:"source"`
	ExternalID string `json:"externalId"`
	Author     string `json:"author"`
}
type Task struct {
	ID            string   `json:"id"`
	IssueID       string   `json:"issueId"`
	Title         string   `json:"title"`
	Prompt        string   `json:"prompt"`
	RepositoryIDs []string `json:"repositoryIds"`
	DependsOn     []string `json:"dependsOn"`
	Harness       string   `json:"harness"`
}
type Plan struct {
	Meta
	WorkspaceID string `json:"workspaceId"`
	IssueID     string `json:"issueId"`
	Title       string `json:"title"`
	Summary     string `json:"summary"`
	Tasks       []Task `json:"tasks"`
	State       string `json:"state"`
}

func (p Plan) Validate() error {
	if strings.TrimSpace(p.Title) == "" || len(p.Tasks) == 0 || len(p.Tasks) > 50 {
		return fmt.Errorf("a plan needs a title and 1–50 tasks")
	}
	byID := map[string]Task{}
	issues := map[string]bool{}
	for _, t := range p.Tasks {
		if t.ID == "" || t.Title == "" || strings.TrimSpace(t.Prompt) == "" || len(t.RepositoryIDs) == 0 || t.Harness == "" {
			return fmt.Errorf("each task needs an ID, title, prompt, repository and harness")
		}
		if _, ok := byID[t.ID]; ok {
			return fmt.Errorf("duplicate task ID %s", t.ID)
		}
		if t.IssueID != "" && issues[t.IssueID] {
			return fmt.Errorf("two tasks cannot run against the same issue; create subtasks instead")
		}
		issues[t.IssueID] = true
		byID[t.ID] = t
	}
	visited, active := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if active[id] {
			return fmt.Errorf("dependency cycle at %s", id)
		}
		if visited[id] {
			return nil
		}
		t, ok := byID[id]
		if !ok {
			return fmt.Errorf("unknown dependency %s", id)
		}
		active[id] = true
		for _, dep := range t.DependsOn {
			if err := visit(dep); err != nil {
				return err
			}
		}
		active[id] = false
		visited[id] = true
		return nil
	}
	for id := range byID {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

type Execution struct {
	Meta
	WorkspaceID  string `json:"workspaceId"`
	PlanID       string `json:"planId"`
	PlanRevision int    `json:"planRevision"`
	Plan         Plan   `json:"plan"`
	State        string `json:"state"`
	RequestKey   string `json:"requestKey"`
}
type Worktree struct {
	Meta
	WorkspaceID    string   `json:"workspaceId"`
	Name           string   `json:"name"`
	Base           string   `json:"base"`
	Head           string   `json:"head"`
	Primary        bool     `json:"primary"`
	Origin         string   `json:"origin"`
	Status         string   `json:"status"`
	Pinned         bool     `json:"pinned"`
	Hidden         bool     `json:"hidden"`
	IssueIDs       []string `json:"issueIds"`
	RequestKey     string   `json:"requestKey,omitempty"`
	RepositoryID   string   `json:"repositoryId"`
	Path           string   `json:"path"`
	Branch         string   `json:"branch"`
	SetupDone      bool     `json:"setupDone"`
	SetupCompleted int      `json:"setupCompleted"`
}
type Run struct {
	Meta
	WorkspaceID string         `json:"workspaceId"`
	ExecutionID string         `json:"executionId"`
	Task        Task           `json:"task"`
	Profile     HarnessProfile `json:"profile"`
	State       string         `json:"state"`
	Error       string         `json:"error"`
	Worktrees   []Worktree     `json:"worktrees"`
	SessionID   string         `json:"sessionId"`
	Repairs     int            `json:"repairs"`
	CompletedAt string         `json:"completedAt"`
}
type HarnessProfile struct {
	ID         string            `json:"id"`
	Label      string            `json:"label"`
	Command    string            `json:"command"`
	Args       []string          `json:"args"`
	PromptMode string            `json:"promptMode"`
	ResumeArgs []string          `json:"resumeArgs"`
	Env        map[string]string `json:"env"`
	SecretRefs map[string]string `json:"secretRefs"`
}
type Session struct {
	Meta
	Kind           string         `json:"kind"`
	WorktreeID     string         `json:"worktreeId"`
	WorktreeIDs    []string       `json:"worktreeIds"`
	WorkspaceID    string         `json:"workspaceId"`
	RunID          string         `json:"runId"`
	Role           string         `json:"role"`
	Harness        HarnessProfile `json:"harness"`
	Handle         string         `json:"handle"`
	Directory      string         `json:"directory"`
	Generation     string         `json:"generation"`
	ConversationID string         `json:"conversationId"`
	State          string         `json:"state"`
	SignalSource   string         `json:"signalSource"`
	SignalAt       string         `json:"signalAt"`
	ExitCode       *int           `json:"exitCode"`
	Error          string         `json:"error"`
	Prompt         string         `json:"prompt"`
	EventCursor    int64          `json:"eventCursor"`
}
type Integration struct {
	Meta
	WebhookEnabled  bool              `json:"webhookEnabled"`
	WebhookPending  bool              `json:"webhookPending"`
	LastWebhook     string            `json:"lastWebhook"`
	PollInterval    int               `json:"pollInterval"`
	WatchStatuses   []string          `json:"watchStatuses"`
	IntakeEnabled   bool              `json:"intakeEnabled"`
	AuthMethod      string            `json:"authMethod"`
	CLIAccount      string            `json:"cliAccount"`
	VerifiedAccount string            `json:"verifiedAccount"`
	LastVerified    string            `json:"lastVerified"`
	LastAttempt     string            `json:"lastAttempt"`
	WorkspaceID     string            `json:"workspaceId"`
	Provider        string            `json:"provider"`
	Label           string            `json:"label"`
	BaseURL         string            `json:"baseUrl"`
	Username        string            `json:"username"`
	Scope           string            `json:"scope"`
	StatusMap       map[string]string `json:"statusMap"`
	LastSync        string            `json:"lastSync"`
	LastFullSync    string            `json:"lastFullSync"`
	Error           string            `json:"error"`
	Enabled         bool              `json:"enabled"`
}
type ChangeRequest struct {
	Meta
	RunID        string     `json:"runId"`
	RepositoryID string     `json:"repositoryId"`
	Number       int        `json:"number"`
	URL          string     `json:"url"`
	Title        string     `json:"title"`
	State        string     `json:"state"`
	Checks       string     `json:"checks"`
	HeadSHA      string     `json:"headSha"`
	Feedback     []Feedback `json:"feedback"`
	Error        string     `json:"error"`
}
type Feedback struct {
	ID   string `json:"id"`
	Body string `json:"body"`
	URL  string `json:"url"`
}
type Action struct {
	Meta
	Kind          string `json:"kind"`
	EntityID      string `json:"entityId"`
	IntegrationID string `json:"integrationId"`
	State         string `json:"state"`
	Body          string `json:"body"`
	Fingerprint   string `json:"fingerprint"`
	Error         string `json:"error"`
}
type Event struct {
	Sequence int64  `json:"sequence"`
	At       string `json:"at"`
	EntityID string `json:"entityId"`
	Kind     string `json:"kind"`
	Message  string `json:"message"`
}

type QueueEntry struct {
	Meta
	WorkspaceID   string `json:"workspaceId"`
	IssueID       string `json:"issueId"`
	IntegrationID string `json:"integrationId"`
	State         string `json:"state"`
	Fingerprint   string `json:"fingerprint"`
}

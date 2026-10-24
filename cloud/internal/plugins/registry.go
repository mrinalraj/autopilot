// Package plugins defines the bundled integration contracts shared by both distributions.
package plugins

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

type Manifest struct {
	ID              string   `json:"id"`
	Type            string   `json:"type"`
	Label           string   `json:"label"`
	Version         string   `json:"version"`
	ContractVersion int      `json:"contractVersion"`
	Distributions   []string `json:"distributions"`
	Platforms       []string `json:"platforms"`
	Architectures   []string `json:"architectures"`
	Capabilities    []string `json:"capabilities"`
	AuthMethods     []string `json:"authMethods"`
	Available       bool     `json:"available"`
	Reason          string   `json:"reason"`
}
type LaunchRequest struct {
	Session     domain.Session
	Environment []string
	Executable  string
}
type Inspection struct {
	Exists   bool
	Dead     bool
	ExitCode int
	Attached int
	Preview  string
}
type AgentCommand struct {
	Executable string
	Args       []string
}
type Agent interface {
	Prepare(context.Context, domain.Session, string, string) (AgentCommand, error)
}
type Launcher interface {
	Start(context.Context, LaunchRequest) error
	Inspect(context.Context, string) (Inspection, error)
	Send(context.Context, string, string) error
	Interrupt(context.Context, string) error
	Stop(context.Context, string) error
}
type Tracker interface {
	Pull(context.Context, domain.Integration, string) ([]domain.Issue, error)
	Statuses(context.Context, domain.Integration) (map[string]string, error)
	Transition(context.Context, domain.Integration, domain.Issue, string) error
	Comment(context.Context, domain.Integration, domain.Issue, string) error
}
type GitProvider interface {
	Observe(context.Context, domain.Integration, domain.Repository, domain.Run) (domain.ChangeRequest, error)
	Create(context.Context, domain.Integration, domain.Repository, domain.Run, string, string) (domain.ChangeRequest, error)
}

// Optional provider capabilities remain separate from creation and observation.
type ChangeReview interface {
	Mergeability(context.Context, domain.Integration, domain.Repository, int) (string, error)
	Comments(context.Context, domain.Integration, domain.Repository, int) ([]domain.Feedback, error)
}
type Registry struct {
	mu       sync.RWMutex
	Profiles map[string]domain.HarnessProfile
}

func New(custom []domain.HarnessProfile) (*Registry, error) {
	r := &Registry{Profiles: map[string]domain.HarnessProfile{}}
	for _, p := range []domain.HarnessProfile{
		{ID: "claude", Label: "Claude Code", Command: "claude", PromptMode: "arg", ResumeArgs: []string{"--resume", "{conversation}"}},
		{ID: "codex", Label: "Codex", Command: "codex", PromptMode: "arg", ResumeArgs: []string{"resume", "{conversation}"}},
		{ID: "agy", Label: "Antigravity", Command: "agy", Args: []string{"--prompt-interactive"}, PromptMode: "arg", ResumeArgs: []string{"--conversation", "{conversation}"}},
		{ID: "opencode", Label: "OpenCode", Command: "opencode", Args: []string{"--prompt"}, PromptMode: "arg", ResumeArgs: []string{"--session", "{conversation}"}},
	} {
		r.Profiles[p.ID] = p
	}
	for _, p := range custom {
		if err := ValidateProfile(p); err != nil {
			return nil, err
		}
		r.Profiles[p.ID] = p
	}
	return r, nil
}
func ValidateProfile(p domain.HarnessProfile) error {
	if p.ID == "" || p.Command == "" {
		return fmt.Errorf("harness needs an id and executable")
	}
	if p.PromptMode != "arg" && p.PromptMode != "paste" {
		return fmt.Errorf("promptMode must be arg or paste")
	}
	for k := range p.Env {
		if strings.HasPrefix(k, "AUTOPILOT_") {
			return fmt.Errorf("AUTOPILOT_ environment is reserved")
		}
	}
	for k := range p.SecretRefs {
		if strings.HasPrefix(k, "AUTOPILOT_") {
			return fmt.Errorf("AUTOPILOT_ environment is reserved")
		}
	}
	return nil
}
func (r *Registry) Profile(id string) (domain.HarnessProfile, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.Profiles[id]
	if !ok {
		return p, fmt.Errorf("unknown harness %q", id)
	}
	return p, nil
}
func (r *Registry) Manifests(ctx context.Context) []Manifest {
	r.mu.RLock()
	defer r.mu.RUnlock()
	makeM := func(id, kind, label string, caps ...string) Manifest {
		return Manifest{ID: id, Type: kind, Label: label, Version: "0.1.0", ContractVersion: 1, Distributions: []string{"cloud", "desktop"}, Platforms: []string{"linux", "darwin"}, Architectures: []string{"amd64", "arm64"}, Capabilities: caps, Available: true}
	}
	out := []Manifest{makeM("native", "tracker", "Autopilot", "issues", "comments", "status"), makeM("linear", "tracker", "Linear", "sync", "comments", "status", "polling", "signed-webhooks", "intake", "ticket-discovery"), makeM("jira", "tracker", "Jira Cloud", "sync", "comments", "status", "polling", "signed-webhooks", "intake", "ticket-discovery"), makeM("github", "git-provider", "GitHub", "changes", "checks", "reviews", "comments", "mergeability"), makeM("gitlab", "git-provider", "GitLab", "changes", "checks", "reviews", "comments", "mergeability")}
	for n := range out {
		if out[n].ID == "native" {
			continue
		}
		out[n].AuthMethods = []string{"token"}
		if out[n].ID == "github" {
			out[n].AuthMethods = append(out[n].AuthMethods, "cli")
		}
	}
	m := makeM("tmux", "launcher", "Terminal", "attach", "input", "interrupt", "stop")
	if _, err := exec.LookPath("tmux"); err != nil {
		m.Available = false
		m.Reason = "tmux is not installed"
	}
	out = append(out, m)
	ids := []string{}
	for id := range r.Profiles {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		p := r.Profiles[id]
		m := makeM(id, "agent", p.Label, "terminal", "worker", "orchestrator")
		if len(p.ResumeArgs) > 0 {
			m.Capabilities = append(m.Capabilities, "resume-by-id")
		}
		if id == "claude" {
			m.Capabilities = append(m.Capabilities, "native-state", "automatic-followup")
		}
		c, cancel := context.WithTimeout(ctx, 2*time.Second)
		cmd := exec.CommandContext(c, p.Command, "--version")
		if err := cmd.Run(); err != nil {
			m.Available = false
			m.Reason = "CLI unavailable; install it and complete its login in the runner"
		}
		cancel()
		if !slices.Contains(m.Platforms, runtime.GOOS) {
			m.Available = false
			m.Reason = "Unsupported operating system"
		}
		out = append(out, m)
	}
	return out
}

func (r *Registry) AllProfiles() []domain.HarnessProfile {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []domain.HarnessProfile{}
	for _, p := range r.Profiles {
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b domain.HarnessProfile) int { return strings.Compare(a.ID, b.ID) })
	return out
}
func (r *Registry) SetProfile(p domain.HarnessProfile) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Profiles[p.ID] = p
}

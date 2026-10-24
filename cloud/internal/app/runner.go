package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func (a *App) Loop(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	slow := time.NewTicker(30 * time.Second)
	defer slow.Stop()
	syncTick := time.NewTicker(10 * time.Second)
	defer syncTick.Stop()
	cleanup := time.NewTicker(time.Hour)
	defer cleanup.Stop()
	if err := a.DiscoverWorktrees(ctx, ""); err != nil {
		slog.Error("worktree discovery", "error", err)
	}
	if err := a.Reconcile(ctx, true); err != nil {
		slog.Error("reconcile", "error", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			a.EnsureTriage(ctx)
			if err := a.Schedule(ctx); err != nil {
				slog.Error("scheduler", "error", err)
			}
		case <-slow.C:
			a.DiscoverWorktrees(ctx, "")
			a.Reconcile(ctx, false)
			a.ObserveChanges(ctx)
			a.QueueOrchestratorEvents(ctx)
			a.DeliverActions(ctx)
		case <-syncTick.C:
			a.SyncAll(ctx)
		case <-cleanup.C:
			a.Retention(ctx)
		}
	}
}
func (a *App) Schedule(ctx context.Context) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	runs, err := storage.List[domain.Run](ctx, a.Store.DB, "runs")
	if err != nil {
		return err
	}
	sessions, err := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
	if err != nil {
		return err
	}
	active := 0
	for _, s := range sessions {
		if s.Role == "worker" && live(s.State) {
			active++
		}
	}
	for _, r := range runs {
		if active >= a.Config.MaxWorkers {
			break
		}
		if r.State != "queued" {
			continue
		}
		execution, e := storage.Get[domain.Execution](ctx, a.Store.DB, "executions", r.ExecutionID)
		if e != nil {
			return e
		}
		if execution.State != "active" {
			continue
		}
		ready := true
		for _, dep := range r.Task.DependsOn {
			found := false
			for _, other := range runs {
				if other.ExecutionID == r.ExecutionID && other.Task.ID == dep && other.State == "completed" {
					found = true
				}
			}
			if !found {
				ready = false
			}
		}
		if !ready {
			continue
		}
		if r.Task.IssueID != "" {
			i, e := storage.Get[domain.Issue](ctx, a.Store.DB, "issues", r.Task.IssueID)
			if e != nil {
				return e
			}
			if i.Status == "canceled" || i.Status == "done" {
				continue
			}
		}
		r.State = "preparing"
		r.Touch()
		if e = a.save(ctx, r, r.ID, "run.preparing", "Preparing "+r.Task.Title); e != nil {
			return e
		}
		if e = a.launchRun(ctx, &r); e != nil {
			r.State = "failed"
			r.Error = e.Error()
			r.Touch()
			a.save(ctx, r, r.ID, "run.failed", r.Error)
			continue
		}
		active++
	}
	return nil
}
func live(state string) bool {
	return slices.Contains([]string{"starting", "working", "idle", "needs_input", "unknown"}, state)
}
func (a *App) launchRun(ctx context.Context, r *domain.Run) error {
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	dir := filepath.Join(a.Config.DataDir, "runs", r.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	for _, rid := range r.Task.RepositoryIDs {
		repo, err := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", rid)
		if err != nil {
			return err
		}
		idx := -1
		for n, w := range r.Worktrees {
			if w.RepositoryID == rid {
				idx = n
			}
		}
		if idx < 0 {
			r.Worktrees = append(r.Worktrees, domain.Worktree{RepositoryID: rid, Path: filepath.Join(dir, rid), Branch: "autopilot/" + r.ID[:12]})
			idx = len(r.Worktrees) - 1
		}
		w := &r.Worktrees[idx]
		if _, err = repos.Worktree(ctx, repo.Path, w.Path, w.Branch, repo.DefaultBranch); err != nil {
			return err
		}
		if err = a.save(ctx, *r, r.ID, "worktree.prepared", "Prepared "+repo.Name); err != nil {
			return err
		}
		if !w.SetupDone {
			for index, script := range repo.Setup {
				if index < w.SetupCompleted {
					continue
				}
				stepCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
				cmd := exec.CommandContext(stepCtx, "/bin/sh", "-c", script)
				cmd.Dir = w.Path
				cmd.Env = a.baseEnv()
				log, err := os.OpenFile(filepath.Join(dir, "setup.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					cancel()
					return err
				}
				cmd.Stdout = log
				cmd.Stderr = log
				err = cmd.Run()
				log.Close()
				cancel()
				if err != nil {
					return fmt.Errorf("setup failed in %s; see run setup log: %w", repo.Name, err)
				}
				w.SetupCompleted = index + 1
				if err = a.save(ctx, *r, r.ID, "setup.step", "Completed setup step in "+repo.Name); err != nil {
					return err
				}
			}
			w.SetupDone = true
			if err = a.save(ctx, *r, r.ID, "setup.completed", "Setup complete for "+repo.Name); err != nil {
				return err
			}
		}
	}
	if err := a.discoverWorktrees(ctx, ""); err != nil {
		return err
	}
	if updated, err := storage.Get[domain.Run](ctx, a.Store.DB, "runs", r.ID); err == nil {
		r.Worktrees = updated.Worktrees
	}
	profile := r.Profile
	var err error
	if profile.Command == "" {
		return fmt.Errorf("approved harness profile is missing; propose a new plan")
	}
	brief := fmt.Sprintf("# %s\n\n%s\n\n## Worktrees\n", r.Task.Title, r.Task.Prompt)
	for _, w := range r.Worktrees {
		brief += "- " + w.Path + " (branch " + w.Branch + ")\n"
	}
	brief += "\nKeep changes inside the assigned worktrees. Follow repository instructions and run relevant checks. Use `autopilot report` for progress and `autopilot changes create` to open a PR/MR. Do not merge changes or delegate workers.\n"
	briefPath := filepath.Join(dir, "brief.md")
	if err = os.WriteFile(briefPath, []byte(brief), 0600); err != nil {
		return err
	}
	s := domain.Session{Meta: domain.NewMeta(), WorkspaceID: r.WorkspaceID, RunID: r.ID, Role: "worker", Harness: profile, Directory: r.Worktrees[0].Path, Generation: domain.ID(), State: "starting", SignalSource: "runner", SignalAt: domain.Now(), Prompt: "Read the task brief at " + briefPath + " and implement the approved task."}
	s.Kind = "agent"
	for _, w := range r.Worktrees {
		s.WorktreeIDs = append(s.WorktreeIDs, w.ID)
	}
	s.WorktreeID = r.Worktrees[0].ID
	s.Handle = "ap-" + s.ID
	r.SessionID = s.ID
	if err = a.Store.Tx(ctx, func(q storage.Queryer) error {
		if e := persist(ctx, q, s); e != nil {
			return e
		}
		return persist(ctx, q, *r)
	}); err != nil {
		return err
	}
	if err = a.startSession(ctx, &s); err != nil {
		s.State = "stopped"
		s.Error = err.Error()
		s.Touch()
		a.save(ctx, s, s.ID, "session.failed", s.Error)
		return err
	}
	r.State = "running"
	r.Error = ""
	r.Touch()
	if err = a.save(ctx, *r, r.ID, "run.started", "Started "+r.Task.Title); err != nil {
		return err
	}
	a.localIssueStatus(ctx, r.Task.IssueID, "in_progress")
	if execution, e := storage.Get[domain.Execution](ctx, a.Store.DB, "executions", r.ExecutionID); e == nil && execution.Plan.IssueID != r.Task.IssueID {
		a.localIssueStatus(ctx, execution.Plan.IssueID, "in_progress")
	}
	return nil
}
func (a *App) baseEnv() []string {
	home := filepath.Join(a.Config.DataDir, "agent-home")
	if a.Config.ExecutionEnvironment == "host" {
		home, _ = os.UserHomeDir()
	}
	path := filepath.Join(a.Config.DataDir, "tools", "bin") + ":" + os.Getenv("PATH")
	env := []string{"HOME=" + home, "PATH=" + path, "TERM=xterm-256color", "LANG=C.UTF-8", "GIT_TERMINAL_PROMPT=0", "AUTOPILOT_URL=" + a.APIURL}
	if a.Config.ExecutionEnvironment == "host" {
		// Share configuration locations and the existing credential agent explicitly.
		// Never inherit the parent agent's tokens, session identity, or arbitrary secrets.
		// USER is required by Claude's macOS Keychain credential lookup.
		for _, key := range []string{"USER", "LOGNAME", "SHELL", "TMPDIR", "SSH_AUTH_SOCK", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "GNUPGHOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"} {
			if value := os.Getenv(key); value != "" {
				env = append(env, key+"="+value)
			}
		}
	}
	return env
}
func (a *App) startSession(ctx context.Context, s *domain.Session) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	token := randomToken()
	if err = a.SetSecret("session-"+s.ID+"-"+s.Generation, token); err != nil {
		return err
	}
	env := a.baseEnv()
	env = append(env, "AUTOPILOT_SESSION_ID="+s.ID, "AUTOPILOT_GENERATION="+s.Generation, "AUTOPILOT_TOKEN="+token)
	for k, v := range s.Harness.Env {
		env = append(env, k+"="+v)
	}
	for k, ref := range s.Harness.SecretRefs {
		v, e := a.Secret(ref)
		if e != nil {
			return fmt.Errorf("missing harness secret %s", ref)
		}
		env = append(env, k+"="+v)
	}
	// Paste-only harnesses require the user to confirm readiness. No timed blind input.
	if s.Harness.PromptMode == "paste" && s.ConversationID == "" {
		s.State = "needs_input"
		s.Error = "Terminal started. Send the saved prompt when the CLI is ready."
	} else {
		s.State = "unknown"
		s.Error = ""
	}
	s.Touch()
	if err = a.save(ctx, *s, s.ID, "session.starting", "Starting "+s.Harness.Label+" "+s.Role); err != nil {
		return err
	}
	return a.Launcher.Start(ctx, plugins.LaunchRequest{Session: *s, Environment: env, Executable: exe})
}
func (a *App) Orchestrator(ctx context.Context, workspaceID string) (domain.Session, error) {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	var s domain.Session
	w, err := storage.Get[domain.Workspace](ctx, a.Store.DB, "workspaces", workspaceID)
	if err != nil {
		return s, err
	}
	all, err := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
	if err != nil {
		return s, err
	}
	for _, x := range all {
		if x.Role == "orchestrator" && x.WorkspaceID == workspaceID && live(x.State) {
			return x, nil
		}
	}
	p, err := a.Plugins.Profile(w.OrchestratorHarness)
	if err != nil {
		return s, err
	}
	s = domain.Session{Meta: domain.NewMeta(), WorkspaceID: workspaceID, Role: "orchestrator", Harness: p, Directory: w.Root, Generation: domain.ID(), State: "starting", SignalSource: "runner", SignalAt: domain.Now()}
	s.Handle = "ap-" + s.ID
	s.Prompt = "You are the workspace coordinator. Pick up every triage issue (workflowState=triage), including unplanned issues assigned to this coordinator (workflowDetail=Planning) in this workspace, inspect the relevant code, and create one linked plan per issue. Always set the plan issueId; do not duplicate existing plans. After handling all queued work, run `autopilot report --state idle --message 'Ready for triage'` as your final tool call so later tickets can be delivered. If blocked, report needs_input. Harness permission bypass is enabled; plan approval is still a separate human decision.  Inspect issues and repositories with `autopilot snapshot`. Propose a structured plan with `autopilot plan --file <json>`. A plan contains workspaceId, issueId, title, summary and tasks (id, issueId, title, prompt, repositoryIds, dependsOn, harness). Work only within workspace " + workspaceID + ". Plans require human approval; the scheduler dispatches approved tasks. Coordinate and monitor using `autopilot snapshot`, `autopilot events`, and `autopilot followup --run <id> --message <text>`. Do not implement changes yourself, merge code, or bypass approval. Report blockers using `autopilot report --state needs_input --message <text>`. Respond to queued workspace updates and human requests; never infer task success from process exit."
	if err = a.Store.DB.QueryRowContext(ctx, "SELECT coalesce(max(sequence),0) FROM events").Scan(&s.EventCursor); err != nil {
		return s, err
	}
	if err = a.save(ctx, s, s.ID, "orchestrator.created", "Preparing workspace orchestrator"); err != nil {
		return s, err
	}
	if err = a.startSession(ctx, &s); err != nil {
		s.State = "stopped"
		s.Error = err.Error()
		s.Touch()
		a.save(ctx, s, s.ID, "session.failed", s.Error)
	}
	return s, err
}
func (a *App) Reconcile(ctx context.Context, startup bool) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	sessions, err := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
	if err != nil {
		return err
	}
	workers := 0
	orchestrators := map[string]int{}
	// Count survivors before considering recovery so recovery never exceeds limits.
	for _, s := range sessions {
		if !live(s.State) {
			continue
		}
		i, e := a.Launcher.Inspect(ctx, s.Handle)
		if e == nil && i.Exists && !i.Dead {
			if s.Role == "worker" {
				workers++
			} else if s.Role == "orchestrator" {
				orchestrators[s.WorkspaceID]++
			}
		}
	}
	for _, s := range sessions {
		if !live(s.State) {
			continue
		}
		i, e := a.Launcher.Inspect(ctx, s.Handle)
		if e != nil {
			continue
		}
		if i.Exists && !i.Dead {
			continue
		}
		if i.Exists && i.Dead {
			s.State = "exited"
			s.ExitCode = &i.ExitCode
			s.Error = "Agent exited. Review its result or resume the conversation."
		} else {
			s.State = "resume_required"
			s.Error = "Agent process is missing. Resume requires a saved conversation ID."
		}
		if s.Kind == "shell" {
			s.State = "exited"
			s.Error = "Terminal exited. Open a new terminal to continue."
		}
		canResume := s.Kind != "shell" && startup && !i.Exists && s.ConversationID != "" && len(s.Harness.ResumeArgs) > 0
		if canResume && ((s.Role == "worker" && workers < a.Config.MaxWorkers) || (s.Role == "orchestrator" && orchestrators[s.WorkspaceID] < a.Config.MaxOrchestrators)) {
			s.Generation = domain.ID()
			if e = a.startSession(ctx, &s); e == nil {
				if s.Role == "worker" {
					workers++
				} else {
					orchestrators[s.WorkspaceID]++
				}
				continue
			}
			s.State = "resume_required"
			s.Error = e.Error()
		}
		s.SignalSource = "runner"
		s.SignalAt = domain.Now()
		s.Touch()
		if e = a.save(ctx, s, s.ID, "session.attention", s.Error); e != nil {
			return e
		}
		a.notify(ctx, s.ID, s.Error)
	}
	if startup {
		actions, e := storage.List[domain.Action](ctx, a.Store.DB, "actions")
		if e != nil {
			return e
		}
		for _, action := range actions {
			if action.State != "delivering" {
				continue
			}
			action.State = "uncertain"
			action.Error = "Server restarted during delivery. Check the destination before confirming or retrying."
			action.Touch()
			if e = a.save(ctx, action, action.ID, "action.uncertain", action.Error); e != nil {
				return e
			}
		}
		runs, e := storage.List[domain.Run](ctx, a.Store.DB, "runs")
		if e != nil {
			return e
		}
		for _, r := range runs {
			if r.State == "preparing" {
				r.State = "failed"
				r.Error = "Server restarted during preparation. Retry reuses prepared worktrees."
				if r.SessionID != "" {
					s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
					if e == nil && live(s.State) {
						r.State = "running"
						r.Error = ""
					}
				}
				r.Touch()
				a.save(ctx, r, r.ID, "run.reconciled", r.Error)
			}
		}
	}
	return nil
}
func (a *App) SessionAction(ctx context.Context, id, action, body, conversation string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	s, err := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", id)
	if err != nil {
		return err
	}
	switch action {
	case "send":
		if !live(s.State) {
			return fmt.Errorf("session is not running")
		}
		if strings.TrimSpace(body) == "" {
			return fmt.Errorf("message is empty")
		}
		if err = a.Launcher.Send(ctx, s.Handle, body); err != nil {
			return err
		}
		s.State = "working"
		s.Error = ""
	case "interrupt":
		if err = a.Launcher.Interrupt(ctx, s.Handle); err != nil {
			return err
		}
		s.State = "unknown"
	case "stop":
		if err = a.Launcher.Stop(ctx, s.Handle); err != nil {
			return err
		}
		s.State = "stopped"
	case "resume":
		if s.Kind == "shell" {
			return fmt.Errorf("open a new terminal; shells have no conversation to resume")
		}
		if live(s.State) {
			return fmt.Errorf("session is already running")
		}
		if s.RunID != "" {
			r, e := storage.Get[domain.Run](ctx, a.Store.DB, "runs", s.RunID)
			if e != nil {
				return e
			}
			if r.State != "running" {
				return fmt.Errorf("only an active run can resume; create a new plan for completed or canceled work")
			}
		}
		if conversation != "" {
			s.ConversationID = conversation
		}
		if s.ConversationID == "" || len(s.Harness.ResumeArgs) == 0 {
			return fmt.Errorf("exact conversation ID required; this harness must support resume")
		}
		all, e := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
		if e != nil {
			return e
		}
		count := 0
		for _, other := range all {
			if other.Role == s.Role && live(other.State) && (s.Role != "orchestrator" || other.WorkspaceID == s.WorkspaceID) {
				count++
			}
		}
		limit := a.Config.MaxWorkers
		if s.Role == "orchestrator" {
			limit = a.Config.MaxOrchestrators
		}
		if count >= limit {
			return fmt.Errorf("session concurrency limit reached")
		}
		if err = a.Launcher.Stop(ctx, s.Handle); err != nil {
			return err
		}
		s.Generation = domain.ID()
		s.State = "starting"
		s.Touch()
		if err = a.save(ctx, s, s.ID, "session.resuming", "Resuming exact conversation"); err != nil {
			return err
		}
		if err = a.startSession(ctx, &s); err != nil {
			s.State = "resume_required"
			s.Error = err.Error()
			a.save(ctx, s, s.ID, "session.failed", s.Error)
		}
		return err
	default:
		return fmt.Errorf("unknown session action")
	}
	s.SignalSource = "user"
	s.SignalAt = domain.Now()
	s.Touch()
	return a.save(ctx, s, s.ID, "session."+action, "Session "+action)
}
func (a *App) Signal(ctx context.Context, id, generation, state, conversation, message string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	return a.signal(ctx, id, generation, state, conversation, message, "agent")
}

// Native hooks are the only readiness signal used for automatic input. Process output
// and an agent's self-reported idle status are deliberately insufficient.
func (a *App) NativeSignal(ctx context.Context, id, generation, event, conversation, notification string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	state := "unknown"
	switch event {
	case "Stop":
		state = "idle"
	case "UserPromptSubmit", "PreToolUse":
		state = "working"
	case "PermissionRequest":
		state = "needs_input"
	case "Notification":
		if notification != "permission_prompt" && notification != "elicitation_dialog" {
			return nil
		}
		state = "needs_input"
	case "SessionStart":
	default:
		return fmt.Errorf("unsupported native event")
	}
	return a.signal(ctx, id, generation, state, conversation, event, "native-hook")
}
func (a *App) signal(ctx context.Context, id, generation, state, conversation, message, source string) error {
	if !slices.Contains([]string{"working", "idle", "needs_input", "unknown"}, state) {
		return fmt.Errorf("invalid agent signal")
	}
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		s, e := storage.Get[domain.Session](ctx, q, "sessions", id)
		if e != nil {
			return e
		}
		if s.Generation != generation || !live(s.State) {
			return fmt.Errorf("stale session signal")
		}
		s.State = state
		s.SignalSource = source
		s.SignalAt = domain.Now()
		if conversation != "" {
			s.ConversationID = conversation
		}
		s.Touch()
		if e = persist(ctx, q, s); e != nil {
			return e
		}
		return storage.Event(ctx, q, s.ID, "agent."+state, message)
	})
}
func (a *App) localIssueStatus(ctx context.Context, id, state string) {
	if id == "" {
		return
	}
	a.Store.Tx(ctx, func(q storage.Queryer) error {
		i, e := storage.Get[domain.Issue](ctx, q, "issues", id)
		if e != nil {
			return e
		}
		if i.Source != "native" || i.Status == "canceled" {
			return nil
		}
		i.Status = state
		i.Touch()
		return persist(ctx, q, i)
	})
}
func (a *App) RunAction(ctx context.Context, id, action string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	r, err := storage.Get[domain.Run](ctx, a.Store.DB, "runs", id)
	if err != nil {
		return err
	}
	switch action {
	case "retry":
		if r.State != "failed" {
			return fmt.Errorf("only failed preparation can be retried")
		}
		if r.SessionID != "" {
			s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
			if e == nil && live(s.State) {
				return fmt.Errorf("a session is still running")
			}
		}
		r.State = "queued"
		r.Error = ""
	case "complete", "cancel":
		if r.SessionID != "" {
			s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
			if e == nil {
				if e = a.Launcher.Stop(ctx, s.Handle); e != nil {
					return e
				}
				s.State = "stopped"
				s.Touch()
				if e = a.save(ctx, s, s.ID, "session.stopped", "Run ended"); e != nil {
					return e
				}
			}
		}
		if action == "complete" {
			r.State = "completed"
			r.CompletedAt = domain.Now()
		} else {
			r.State = "canceled"
		}
	case "cleanup":
		if r.State != "completed" && r.State != "canceled" {
			return fmt.Errorf("end the run before removing its worktrees")
		}
		for _, w := range r.Worktrees {
			if w.ID != "" {
				current, e := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", w.ID)
				if e != nil {
					return e
				}
				if current.Pinned || current.Primary || current.Origin != "run" {
					return fmt.Errorf("this worktree is protected from run cleanup")
				}
				if e = a.worktreeBusy(ctx, current); e != nil {
					return e
				}
			}
			if _, e := os.Stat(w.Path); os.IsNotExist(e) {
				continue
			}
			risk, e := repos.Risk(ctx, w.Path)
			if e != nil {
				return e
			}
			if risk != "" {
				return fmt.Errorf("cleanup refused: %s", risk)
			}
		}
		if r.SessionID != "" {
			s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", r.SessionID)
			if e != nil {
				return e
			}
			if e = a.Launcher.Stop(ctx, s.Handle); e != nil {
				return e
			}
			if live(s.State) {
				s.State = "stopped"
				s.Touch()
				if e = a.save(ctx, s, s.ID, "session.stopped", "Stopped before worktree cleanup"); e != nil {
					return e
				}
			}
		}
		for _, w := range r.Worktrees {
			if _, e := os.Stat(w.Path); os.IsNotExist(e) {
				continue
			}
			repo, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", w.RepositoryID)
			if e != nil {
				return e
			}
			risk, e := repos.Risk(ctx, w.Path)
			if e != nil || risk != "" {
				return fmt.Errorf("worktree changed during cleanup")
			}
			if _, e = repos.Git(ctx, repo.Path, "worktree", "remove", "--", w.Path); e != nil {
				return e
			}
		}
		for _, w := range r.Worktrees {
			if w.ID != "" {
				current, e := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", w.ID)
				if e == nil {
					current.Status = "removed"
					current.Hidden = true
					current.Touch()
					if e = a.save(ctx, current, current.ID, "worktree.removed", "Removed run worktree"); e != nil {
						return e
					}
				}
			}
		}
		r.Worktrees = []domain.Worktree{}
	default:
		return fmt.Errorf("unknown run action")
	}
	r.Touch()
	if err = a.save(ctx, r, r.ID, "run."+action, "Run "+action); err != nil {
		return err
	}
	if action == "complete" {
		execution, e := storage.Get[domain.Execution](ctx, a.Store.DB, "executions", r.ExecutionID)
		if e != nil {
			return e
		}
		if r.Task.IssueID != execution.Plan.IssueID {
			a.localIssueStatus(ctx, r.Task.IssueID, "done")
		}
	}
	if action == "complete" || action == "cancel" {
		return a.Store.Tx(ctx, func(q storage.Queryer) error {
			runs, e := storage.List[domain.Run](ctx, q, "runs")
			if e != nil {
				return e
			}
			state := "completed"
			for _, other := range runs {
				if other.ExecutionID != r.ExecutionID {
					continue
				}
				if other.State != "completed" && other.State != "canceled" {
					return nil
				}
				if other.State == "canceled" {
					state = "canceled"
				}
			}
			execution, e := storage.Get[domain.Execution](ctx, q, "executions", r.ExecutionID)
			if e != nil {
				return e
			}
			execution.State = state
			execution.Touch()
			if e = persist(ctx, q, execution); e != nil {
				return e
			}
			if state == "completed" && execution.Plan.IssueID != "" {
				issue, e := storage.Get[domain.Issue](ctx, q, "issues", execution.Plan.IssueID)
				if e != nil {
					return e
				}
				if issue.Source == "native" && issue.Status != "canceled" {
					issue.Status = "done"
					issue.Touch()
					if e = persist(ctx, q, issue); e != nil {
						return e
					}
				}
			}
			return storage.Event(ctx, q, execution.ID, "execution."+state, "Plan execution "+state)
		})
	}
	return nil
}
func (a *App) Retention(ctx context.Context) {
	runs, e := storage.List[domain.Run](ctx, a.Store.DB, "runs")
	if e != nil {
		return
	}
	for _, r := range runs {
		if r.State != "completed" || len(r.Worktrees) == 0 {
			continue
		}
		t, e := time.Parse(time.RFC3339Nano, r.CompletedAt)
		if e == nil && time.Since(t) > time.Duration(a.Config.RetentionDays)*24*time.Hour {
			a.RunAction(ctx, r.ID, "cleanup")
		}
	}
}
func (a *App) SessionPreview(ctx context.Context, id string) (any, error) {
	s, e := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", id)
	if e != nil {
		return nil, e
	}
	i, e := a.Launcher.Inspect(ctx, s.Handle)
	return map[string]any{"preview": i.Preview, "prompt": s.Prompt}, e
}
func (a *App) writeJSON(file string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return os.WriteFile(file, b, 0600)
}

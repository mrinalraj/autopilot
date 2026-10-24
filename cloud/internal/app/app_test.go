package app

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

type fakeLauncher struct {
	sessions      map[string]plugins.Inspection
	starts, sends int
	last          plugins.LaunchRequest
}

func (f *fakeLauncher) Start(_ context.Context, r plugins.LaunchRequest) error {
	f.starts++
	f.last = r
	f.sessions[r.Session.Handle] = plugins.Inspection{Exists: true}
	return nil
}
func (f *fakeLauncher) Inspect(_ context.Context, h string) (plugins.Inspection, error) {
	return f.sessions[h], nil
}
func (f *fakeLauncher) Send(context.Context, string, string) error { f.sends++; return nil }
func (f *fakeLauncher) Interrupt(context.Context, string) error    { return nil }
func (f *fakeLauncher) Stop(_ context.Context, h string) error     { delete(f.sessions, h); return nil }

func fixture(t *testing.T) (*App, domain.Workspace, domain.Repository, *fakeLauncher) {
	t.Helper()
	ctx := context.Background()
	cfg, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Store.Close() })
	f := &fakeLauncher{sessions: map[string]plugins.Inspection{}}
	a.Launcher = f
	w, err := a.CreateWorkspace(ctx, domain.Workspace{Name: "Test workspace"})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(w.Root, "repo")
	if err = os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-b", "main"}, {"-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"}} {
		if _, err = repos.Git(ctx, dir, args...); err != nil {
			t.Fatal(err)
		}
	}
	r, err := a.AddRepository(ctx, domain.Repository{WorkspaceID: w.ID, Path: dir}, false)
	if err != nil {
		t.Fatal(err)
	}
	return a, w, r, f
}
func proposed(t *testing.T, a *App, w domain.Workspace, r domain.Repository, issue string) domain.Plan {
	t.Helper()
	p, err := a.SavePlan(context.Background(), domain.Plan{WorkspaceID: w.ID, Title: "Implement", Tasks: []domain.Task{{ID: "first", IssueID: issue, Title: "First", Prompt: "Implement and test", Harness: "claude", RepositoryIDs: []string{r.ID}}}})
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func records[T any](t *testing.T, a *App, table string) []T {
	t.Helper()
	v, e := storage.List[T](context.Background(), a.Store.DB, table)
	if e != nil {
		t.Fatal(e)
	}
	return v
}

func TestApprovalIsAtomicIdempotentAndFrozen(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	issue, err := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "One issue"})
	if err != nil {
		t.Fatal(err)
	}
	p := proposed(t, a, w, r, issue.ID)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := a.Approve(ctx, p.ID, p.Revision, "same-request"); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(records[domain.Execution](t, a, "executions")) != 1 || len(records[domain.Run](t, a, "runs")) != 1 {
		t.Fatal("duplicate dispatch")
	}
	if _, err = a.SavePlan(ctx, p); err == nil {
		t.Fatal("approved plan was editable")
	}
	if _, err = a.Approve(ctx, p.ID, p.Revision+1, "same-request"); err == nil {
		t.Fatal("key reused for different revision")
	}
	second := proposed(t, a, w, r, issue.ID)
	if _, err = a.Approve(ctx, second.ID, second.Revision, "another-request"); err == nil {
		t.Fatal("same issue dispatched twice")
	}
	if len(records[domain.Execution](t, a, "executions")) != 1 {
		t.Fatal("failed approval did not roll back")
	}
	changed := a.Plugins.Profiles["claude"]
	changed.Command = "changed-after-approval"
	a.Plugins.Profiles["claude"] = changed
	run := records[domain.Run](t, a, "runs")[0]
	if run.Profile.Command != "claude" {
		t.Fatal("harness settings were not captured")
	}
}

func TestDependenciesRecoveryAndGuardedCleanup(t *testing.T) {
	a, w, r, f := fixture(t)
	ctx := context.Background()
	a.Config.MaxWorkers = 1
	p := proposed(t, a, w, r, "")
	p.Tasks = append(p.Tasks, domain.Task{ID: "second", Title: "Second", Prompt: "Depends on first", Harness: "codex", RepositoryIDs: []string{r.ID}, DependsOn: []string{"first"}})
	var err error
	p, err = a.SavePlan(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Approve(ctx, p.ID, p.Revision, "approve"); err != nil {
		t.Fatal(err)
	}
	if err = a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	if f.starts != 1 {
		t.Fatalf("starts=%d", f.starts)
	}
	run := records[domain.Run](t, a, "runs")[0]
	session := records[domain.Session](t, a, "sessions")[0]
	if err = a.Reconcile(ctx, true); err != nil {
		t.Fatal(err)
	}
	if f.starts != 1 {
		t.Fatal("surviving session was duplicated")
	}
	if err = a.Signal(ctx, session.ID, session.Generation, "idle", "exact-conversation", "done turn"); err != nil {
		t.Fatal(err)
	}
	delete(f.sessions, session.Handle)
	if err = a.Reconcile(ctx, true); err != nil {
		t.Fatal(err)
	}
	recovered := records[domain.Session](t, a, "sessions")[0]
	if f.starts != 2 || recovered.ConversationID != "exact-conversation" || recovered.Generation == session.Generation {
		t.Fatal("exact recovery failed")
	}
	if err = a.Signal(ctx, session.ID, session.Generation, "idle", "wrong", "stale"); err == nil {
		t.Fatal("accepted stale generation")
	}
	f.sessions[session.Handle] = plugins.Inspection{Exists: true, Dead: true, ExitCode: 0}
	if err = a.Reconcile(ctx, false); err != nil {
		t.Fatal(err)
	}
	if err = a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	if f.starts != 2 {
		t.Fatal("process exit unblocked dependency")
	}
	if err = a.RunAction(ctx, run.ID, "complete"); err != nil {
		t.Fatal(err)
	}
	if err = a.SessionAction(ctx, session.ID, "resume", "", "exact-conversation"); err == nil {
		t.Fatal("completed run resumed into a worktree eligible for cleanup")
	}
	if err = a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	if f.starts != 3 || f.last.Session.Harness.ID != "codex" {
		t.Fatal("dependent harness did not launch after acceptance")
	}
	if err = os.WriteFile(filepath.Join(run.Worktrees[0].Path, "important.txt"), []byte("preserve me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.RunAction(ctx, run.ID, "cleanup"); err == nil {
		t.Fatal("deleted dirty worktree")
	}
	if _, err = os.Stat(filepath.Join(run.Worktrees[0].Path, "important.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestFollowupRequiresNativeReadinessAndHasRepairBudget(t *testing.T) {
	a, w, r, f := fixture(t)
	ctx := context.Background()
	p := proposed(t, a, w, r, "")
	if _, err := a.Approve(ctx, p.ID, p.Revision, "approval"); err != nil {
		t.Fatal(err)
	}
	if err := a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	run := records[domain.Run](t, a, "runs")[0]
	s := records[domain.Session](t, a, "sessions")[0]
	if _, err := a.Followup(ctx, run.ID, "fix check", "feedback-1"); err != nil {
		t.Fatal(err)
	}
	a.Signal(ctx, s.ID, s.Generation, "idle", "conversation", "agent says idle")
	a.DeliverActions(ctx)
	if f.sends != 0 {
		t.Fatal("self-report caused automatic input")
	}
	a.NativeSignal(ctx, s.ID, s.Generation, "PermissionRequest", "conversation", "")
	a.DeliverActions(ctx)
	if f.sends != 0 {
		t.Fatal("input delivered to permission dialog")
	}
	ready := func() {
		t.Helper()
		if err := a.NativeSignal(ctx, s.ID, s.Generation, "Stop", "conversation", ""); err != nil {
			t.Fatal(err)
		}
		latest := records[domain.Session](t, a, "sessions")[0]
		latest.SignalAt = time.Now().Add(-3 * time.Second).UTC().Format(time.RFC3339Nano)
		if err := a.save(ctx, latest, latest.ID, "test.ready", ""); err != nil {
			t.Fatal(err)
		}
	}
	ready()
	f.sessions[s.Handle] = plugins.Inspection{Exists: true, Attached: 1}
	a.DeliverActions(ctx)
	if f.sends != 0 {
		t.Fatal("input raced attached terminal")
	}
	f.sessions[s.Handle] = plugins.Inspection{Exists: true}
	a.DeliverActions(ctx)
	a.DeliverActions(ctx)
	if f.sends != 1 {
		t.Fatal("follow-up not delivered exactly once")
	}
	a.Followup(ctx, run.ID, "fix another check", "feedback-2")
	ready()
	a.DeliverActions(ctx)
	a.Followup(ctx, run.ID, "third check", "feedback-3")
	ready()
	a.DeliverActions(ctx)
	if f.sends != 2 {
		t.Fatalf("repair budget ignored: %d", f.sends)
	}
	actions := records[domain.Action](t, a, "actions")
	if actions[2].State != "attention" {
		t.Fatal("budget did not surface attention")
	}
}

func TestScopeAndCyclesRejectedBeforeApproval(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	p := proposed(t, a, w, r, "")
	p.Tasks[0].DependsOn = []string{"first"}
	if _, err := a.SavePlan(ctx, p); err == nil {
		t.Fatal("cycle accepted")
	}
	p.Tasks[0].DependsOn = nil
	other, err := a.CreateWorkspace(ctx, domain.Workspace{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	p.WorkspaceID = other.ID
	if _, err = a.SavePlan(ctx, p); err == nil {
		t.Fatal("workspace scope changed")
	}
	p.ID = ""
	if _, err = a.SavePlan(ctx, p); err == nil {
		t.Fatal("cross-workspace repo accepted")
	}
}

func TestOrchestratorReceivesScopedEventsOnce(t *testing.T) {
	a, w, _, f := fixture(t)
	ctx := context.Background()
	s, err := a.Orchestrator(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "Visible task"}); err != nil {
		t.Fatal(err)
	}
	other, err := a.CreateWorkspace(ctx, domain.Workspace{Name: "Other workspace"})
	if err != nil {
		t.Fatal(err)
	}
	a.CreateIssue(ctx, domain.Issue{WorkspaceID: other.ID, Title: "Private task"})
	a.EnsureTriage(ctx)
	a.EnsureTriage(ctx)
	actions := records[domain.Action](t, a, "actions")
	if len(actions) != 1 || actions[0].Kind != "orchestrator.followup" {
		t.Fatal("orchestrator events duplicated or missing", actions)
	}
	if err = a.Signal(ctx, s.ID, s.Generation, "idle", "orch-conversation", "Ready for triage"); err != nil {
		t.Fatal(err)
	}
	s = records[domain.Session](t, a, "sessions")[0]
	s.SignalAt = time.Now().Add(-3 * time.Second).UTC().Format(time.RFC3339Nano)
	a.save(ctx, s, s.ID, "test.ready", "")
	inspection := f.sessions[s.Handle]
	inspection.Attached = 1
	f.sessions[s.Handle] = inspection
	a.DeliverActions(ctx)
	a.DeliverActions(ctx)
	if f.sends != 1 {
		t.Fatal("orchestrator update not delivered once")
	}
	if records[domain.Action](t, a, "actions")[0].State != "delivered" {
		t.Fatal("delivery not persisted")
	}
}

func TestParentIssueWaitsForWholePlan(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	issue, err := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "Whole feature"})
	if err != nil {
		t.Fatal(err)
	}
	p := proposed(t, a, w, r, issue.ID)
	p.IssueID = issue.ID
	p.Tasks = append(p.Tasks, domain.Task{ID: "second", Title: "Dependent part", Prompt: "Finish feature", Harness: "codex", RepositoryIDs: []string{r.ID}, DependsOn: []string{"first"}})
	p, err = a.SavePlan(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Approve(ctx, p.ID, p.Revision, "approve-parent"); err != nil {
		t.Fatal(err)
	}
	if err = a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	runs := records[domain.Run](t, a, "runs")
	if err = a.RunAction(ctx, runs[0].ID, "complete"); err != nil {
		t.Fatal(err)
	}
	if records[domain.Issue](t, a, "issues")[0].Status == "done" {
		t.Fatal("parent completed before dependent task")
	}
	if err = a.Schedule(ctx); err != nil {
		t.Fatal(err)
	}
	if err = a.RunAction(ctx, runs[1].ID, "complete"); err != nil {
		t.Fatal(err)
	}
	if records[domain.Issue](t, a, "issues")[0].Status != "done" {
		t.Fatal("parent did not complete")
	}
}

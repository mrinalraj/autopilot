package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func TestDefaultStorageOutsideCheckout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, xdg := range []string{"", "relative-is-ignored", filepath.Join(home, "custom-data")} {
		t.Setenv("XDG_DATA_HOME", xdg)
		cfg, err := LoadConfig("")
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(home, ".local", "share", "autopilot-cloud")
		if filepath.IsAbs(xdg) {
			want = filepath.Join(xdg, "autopilot-cloud")
		}
		if runtime.GOOS == "darwin" {
			want = filepath.Join(home, "Library", "Application Support", "Autopilot Cloud")
		}
		if cfg.DataDir != want {
			t.Fatalf("data directory: %s, want %s", cfg.DataDir, want)
		}
	}
	explicit := t.TempDir()
	if cfg, err := LoadConfig(explicit); err != nil || cfg.DataDir != explicit {
		t.Fatalf("explicit override: %+v %v", cfg, err)
	}
}

func TestWorkspaceImportIsSelectedAtomicAndReadOnly(t *testing.T) {
	a, existing, existingRepo, _ := fixture(t)
	ctx := context.Background()
	root := t.TempDir()
	makeRepo := func(name string) string {
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := repos.Git(ctx, dir, "init", "-b", "main"); err != nil {
			t.Fatal(err)
		}
		canonical, err := repos.CanonicalPath(dir)
		if err != nil {
			t.Fatal(err)
		}
		return canonical
	}
	first, second := makeRepo("one"), makeRepo("two")
	if err := os.WriteFile(filepath.Join(first, "uncommitted.txt"), []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	scan, err := a.ScanWorkspace(ctx, root)
	if err != nil || len(scan.Repositories) != 2 {
		t.Fatalf("scan: %+v %v", scan, err)
	}
	if len(records[domain.Workspace](t, a, "workspaces")) != 1 {
		t.Fatal("scan created records")
	}
	if _, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Invalid", Root: root}, []string{existingRepo.Path}); err == nil {
		t.Fatal("imported a repository outside the scan")
	}
	if _, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Duplicate", Root: root}, []string{first, first}); err == nil {
		t.Fatal("duplicate selection accepted")
	}
	if _, err := a.AddRepository(ctx, domain.Repository{WorkspaceID: existing.ID, Path: first}, false); err != nil {
		t.Fatal(err)
	}
	// The first insert succeeds, the second conflicts: neither may remain.
	if _, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Rollback", Root: root}, []string{second, first}); err == nil {
		t.Fatal("registered path imported again")
	}
	if len(records[domain.Workspace](t, a, "workspaces")) != 1 || len(records[domain.Repository](t, a, "repositories")) != 2 {
		t.Fatal("partial import survived")
	}
	w, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Selected", Root: root}, []string{second})
	if err != nil {
		t.Fatal(err)
	}
	if w.Root != scan.Root {
		t.Fatal("root is not canonical")
	}
	if _, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Same folder", Root: root}, nil); err == nil {
		t.Fatal("duplicate workspace accepted")
	}
	if content, err := os.ReadFile(filepath.Join(first, "uncommitted.txt")); err != nil || string(content) != "keep me" {
		t.Fatal("source files modified", err)
	}
	empty := t.TempDir()
	t.Setenv("HOME", empty)
	if scan, err := a.ScanWorkspace(ctx, "~"); err != nil || len(scan.Repositories) != 0 {
		t.Fatalf("empty home scan: %+v %v", scan, err)
	}
	if _, err := a.ImportWorkspace(ctx, domain.Workspace{Name: "Empty folder", Root: empty}, nil); err != nil {
		t.Fatal(err)
	}
	if scan, err := a.ScanWorkspace(ctx, existingRepo.Path); err != nil || len(scan.Repositories) != 1 {
		t.Fatalf("single repository scan: %+v %v", scan, err)
	}
}

func TestRemoveWorkspaceKeepsCodeAndOtherWorkspaces(t *testing.T) {
	a, w, repo, _ := fixture(t)
	ctx := context.Background()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	other, err := a.CreateWorkspace(ctx, domain.Workspace{Name: "Keep"})
	check(err)
	otherIssue, err := a.CreateIssue(ctx, domain.Issue{WorkspaceID: other.ID, Title: "Keep issue"})
	check(err)
	project, err := a.CreateProject(ctx, domain.Project{WorkspaceID: w.ID, Name: "Remove project"})
	check(err)
	parent, err := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, ProjectID: project.ID, Title: "Parent"})
	check(err)
	issue, err := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, ProjectID: project.ID, ParentID: parent.ID, Title: "Child"})
	check(err)
	_, err = a.Comment(ctx, issue.ID, "Local comment")
	check(err)
	p := proposed(t, a, w, repo, issue.ID)
	_, err = a.Approve(ctx, p.ID, p.Revision, "remove-test")
	check(err)
	if err := a.RemoveWorkspace(ctx, w.ID, w.Revision); err == nil || !strings.Contains(err.Error(), "runs") {
		t.Fatal("queued work was removed", err)
	}
	check(a.Schedule(ctx))
	run := records[domain.Run](t, a, "runs")[0]
	dirty := filepath.Join(run.Worktrees[0].Path, "keep-uncommitted.txt")
	check(os.WriteFile(dirty, []byte("unfinished work"), 0600))
	if err := a.RemoveWorkspace(ctx, w.ID, w.Revision); err == nil {
		t.Fatal("running work was removed")
	}
	check(a.RunAction(ctx, run.ID, "cancel"))
	orchestrator := domain.Session{Meta: domain.NewMeta(), WorkspaceID: w.ID, Role: "orchestrator", Handle: "remove-orchestrator", State: "idle", Generation: "test"}
	check(a.save(ctx, orchestrator, orchestrator.ID, "test.session", ""))
	if err := a.RemoveWorkspace(ctx, w.ID, w.Revision); err == nil || !strings.Contains(err.Error(), "sessions") {
		t.Fatal("live orchestrator removed", err)
	}
	orchestrator.State = "stopped"
	check(a.save(ctx, orchestrator, orchestrator.ID, "test.session", ""))
	integration := domain.Integration{Meta: domain.NewMeta(), WorkspaceID: w.ID, Provider: "linear", Label: "Remove tracker"}
	check(a.save(ctx, integration, integration.ID, "test.integration", ""))
	check(a.SetSecret("integration-"+integration.ID, "test-secret"))
	change := domain.ChangeRequest{Meta: domain.NewMeta(), RunID: run.ID, RepositoryID: repo.ID, State: "closed"}
	check(a.save(ctx, change, change.ID, "test.change", ""))
	pending := domain.Action{Meta: domain.NewMeta(), EntityID: issue.ID, IntegrationID: integration.ID, Kind: "tracker.comment", State: "pending", Fingerprint: "pending-remove"}
	check(a.save(ctx, pending, pending.ID, "test.action", ""))
	delivering := domain.Action{Meta: domain.NewMeta(), EntityID: run.ID, Kind: "agent.followup", State: "delivering", Fingerprint: "in-flight-remove"}
	check(a.save(ctx, delivering, delivering.ID, "test.action", ""))
	keep := domain.Action{Meta: domain.NewMeta(), EntityID: otherIssue.ID, Kind: "notice", State: "attention", Fingerprint: "keep-action"}
	check(a.save(ctx, keep, keep.ID, "test.action", ""))
	if err := a.RemoveWorkspace(ctx, w.ID, w.Revision); err == nil {
		t.Fatal("in-flight action removed")
	}
	if len(records[domain.Action](t, a, "actions")) != 3 {
		t.Fatal("failed removal partially deleted actions")
	}
	delivering.State = "dismissed"
	check(a.save(ctx, delivering, delivering.ID, "test.action", ""))
	if err := a.RemoveWorkspace(ctx, w.ID, w.Revision+1); err == nil {
		t.Fatal("stale revision accepted")
	}
	check(a.RemoveWorkspace(ctx, w.ID, w.Revision))
	for _, table := range []string{"repositories", "projects", "comments", "plans", "executions", "runs", "sessions", "integrations", "changes"} {
		if len(records[map[string]any](t, a, table)) != 0 {
			t.Fatalf("%s records left behind", table)
		}
	}
	if got := records[domain.Workspace](t, a, "workspaces"); len(got) != 1 || got[0].ID != other.ID {
		t.Fatal("other workspace affected")
	}
	if got := records[domain.Issue](t, a, "issues"); len(got) != 1 || got[0].ID != otherIssue.ID {
		t.Fatal("other issue affected")
	}
	if got := records[domain.Action](t, a, "actions"); len(got) != 1 || got[0].ID != keep.ID {
		t.Fatal("other action affected")
	}
	if content, err := os.ReadFile(dirty); err != nil || string(content) != "unfinished work" {
		t.Fatal("uncommitted work removed", err)
	}
	if _, _, err := repos.Inspect(ctx, repo.Path); err != nil {
		t.Fatal("repository removed", err)
	}
	if _, err := a.Secret("integration-" + integration.ID); !os.IsNotExist(err) {
		t.Fatal("integration credential left behind")
	}
	if _, err := a.enqueue(ctx, pending); err == nil {
		t.Fatal("stale request recreated orphan action")
	}
	events, err := a.Store.Events(ctx, 0)
	check(err)
	for _, event := range events {
		if event.EntityID == w.ID && event.Kind == "workspace.removed" {
			continue
		}
		if event.EntityID != other.ID && event.EntityID != otherIssue.ID && event.EntityID != keep.ID {
			t.Fatalf("removed entity event remains: %+v", event)
		}
	}
	rows, err := a.Store.DB.QueryContext(ctx, "PRAGMA foreign_key_check")
	check(err)
	defer rows.Close()
	if rows.Next() {
		t.Fatal("dangling foreign key")
	}
	// Confirm the directory is still importable after unregistering it.
	rows.Close()
	_, err = a.ImportWorkspace(ctx, domain.Workspace{Name: "Reimport", Root: w.Root}, []string{repo.Path})
	check(err)
	_, err = storage.Get[domain.Workspace](ctx, a.Store.DB, "workspaces", other.ID)
	check(err)
}

package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func TestIndependentWorktreeLifecycle(t *testing.T) {
	a, _, r, f := fixture(t)
	ctx := context.Background()
	external := filepath.Join(t.TempDir(), "external")
	if _, e := repos.Git(ctx, r.Path, "worktree", "add", "-b", "external", external, "HEAD"); e != nil {
		t.Fatal(e)
	}
	if e := a.DiscoverWorktrees(ctx, r.ID); e != nil {
		t.Fatal(e)
	}
	all := records[domain.Worktree](t, a, "worktrees")
	if len(all) != 2 {
		t.Fatalf("discovered %d checkouts", len(all))
	}
	for _, w := range all {
		if w.Primary {
			if e := a.WorktreeAction(ctx, w.ID, "unregister", w.Revision); e == nil {
				t.Fatal("hid primary checkout")
			}
		}
	}
	req := NewWorktree{Name: "Manual task", Branch: "manual-task", Base: "refs/heads/main"}
	w, e := a.CreateWorktree(ctx, r.ID, "one", req)
	if e != nil {
		t.Fatal(e)
	}
	same, e := a.CreateWorktree(ctx, r.ID, "one", req)
	if e != nil || same.ID != w.ID {
		t.Fatal("creation was not idempotent", e)
	}
	if len(records[domain.Run](t, a, "runs")) != 0 || len(records[domain.Plan](t, a, "plans")) != 0 {
		t.Fatal("manual checkout created orchestration work")
	}
	s, e := a.StartWorktreeSession(ctx, w.ID, "shell", "", "")
	if e != nil {
		t.Fatal(e)
	}
	if s.Kind != "shell" || s.WorktreeID != w.ID || f.starts != 1 {
		t.Fatalf("incorrect shell: %+v", s)
	}
	if e = a.WorktreeAction(ctx, w.ID, "unregister", w.Revision); e == nil {
		t.Fatal("hid live terminal")
	}
	if e = a.SessionAction(ctx, s.ID, "stop", "", ""); e != nil {
		t.Fatal(e)
	}
	if e = a.WorktreeAction(ctx, w.ID, "unregister", w.Revision); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(w.Path); e != nil {
		t.Fatal("unregister removed code", e)
	}
	w, _ = storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", w.ID)
	if e = a.WorktreeAction(ctx, w.ID, "restore", w.Revision); e != nil {
		t.Fatal(e)
	}
	w, _ = storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", w.ID)
	if e = os.WriteFile(filepath.Join(w.Path, "uncommitted"), []byte("keep"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = a.WorktreeAction(ctx, w.ID, "remove", w.Revision); e == nil {
		t.Fatal("deleted dirty worktree")
	}
	if e = a.DiscoverWorktrees(ctx, r.ID); e != nil {
		t.Fatal(e)
	}
	stored, _ := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", w.ID)
	if stored.Hidden || !stored.Pinned {
		t.Fatal("lost manual settings")
	}
}

func TestIntakeBaselineDedupeAndWithdrawal(t *testing.T) {
	a, w, _, _ := fixture(t)
	ctx := context.Background()
	i, e := a.SaveIntegration(ctx, domain.Integration{WorkspaceID: w.ID, Provider: "linear", Enabled: true, IntakeEnabled: true, WatchStatuses: []string{"ready"}}, "fake")
	if e != nil {
		t.Fatal(e)
	}
	issue, e := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "Ticket"})
	if e != nil {
		t.Fatal(e)
	}
	issue.IntegrationID = i.ID
	issue.ExternalID = "external"
	issue.ExternalStatusID = "ready"
	issue.SourceUpdatedAt = "v1"
	apply := func(old domain.Issue, known bool) {
		t.Helper()
		if e := a.Store.Tx(ctx, func(q storage.Queryer) error {
			if e := persist(ctx, q, issue); e != nil {
				return e
			}
			return a.reconcileIntake(ctx, q, i, old, issue, known)
		}); e != nil {
			t.Fatal(e)
		}
	}
	apply(domain.Issue{}, false)
	if len(records[domain.QueueEntry](t, a, "queue")) != 0 {
		t.Fatal("baseline entered queue")
	}
	i.LastSync = domain.Now()
	old := issue
	old.ExternalStatusID = "backlog"
	apply(old, true)
	apply(old, true)
	entries := records[domain.QueueEntry](t, a, "queue")
	if len(entries) != 1 || entries[0].State != "pending" {
		t.Fatal("transition was not deduplicated", entries)
	}
	i.IntakeEnabled = false
	if _, e = a.SaveIntegration(ctx, i, ""); e != nil {
		t.Fatal(e)
	}
	entries = records[domain.QueueEntry](t, a, "queue")
	if entries[0].State != "withdrawn" {
		t.Fatal("disabling intake left pending work")
	}
	if len(records[domain.Run](t, a, "runs")) != 0 {
		t.Fatal("intake launched an agent")
	}
}

func TestSignedWebhooks(t *testing.T) {
	a, w, _, _ := fixture(t)
	ctx := context.Background()
	i, e := a.SaveIntegration(ctx, domain.Integration{WorkspaceID: w.ID, Provider: "linear", Enabled: true}, "fake")
	if e != nil {
		t.Fatal(e)
	}
	secret := "a-signing-secret-for-test"
	if _, e = a.ConfigureWebhook(ctx, i.ID, true, secret); e != nil {
		t.Fatal(e)
	}
	body := []byte(fmt.Sprintf(`{"webhookTimestamp":%d,"action":"update"}`, time.Now().UnixMilli()))
	sign := func(body []byte) string {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		return hex.EncodeToString(mac.Sum(nil))
	}
	if e = a.ReceiveWebhook(ctx, i.ID, "bad", "", body); e == nil {
		t.Fatal("accepted forged signature")
	}
	for n := 0; n < 2; n++ {
		if e = a.ReceiveWebhook(ctx, i.ID, sign(body), "", body); e != nil {
			t.Fatal(e)
		}
	}
	var count int
	if e = a.Store.DB.QueryRowContext(ctx, "SELECT count(*) FROM webhook_receipts").Scan(&count); e != nil || count != 1 {
		t.Fatal("delivery was not deduplicated", count, e)
	}
	i, _ = storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", i.ID)
	if !i.WebhookPending || i.LastWebhook == "" {
		t.Fatal("sync was not queued")
	}
	expired := []byte(`{"webhookTimestamp":1}`)
	if e = a.ReceiveWebhook(ctx, i.ID, sign(expired), "", expired); e == nil {
		t.Fatal("accepted expired delivery")
	}
	if _, e = a.ConfigureWebhook(ctx, i.ID, false, ""); e != nil {
		t.Fatal(e)
	}
	if e = a.ReceiveWebhook(ctx, i.ID, sign(body), "", body); e == nil {
		t.Fatal("accepted delivery to disabled receiver")
	}
}

func TestLegacyRunCheckoutMigrationPreservesSessionAndSetup(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	plan := proposed(t, a, w, r, "")
	if _, e := a.Approve(ctx, plan.ID, plan.Revision, "migration"); e != nil {
		t.Fatal(e)
	}
	run := records[domain.Run](t, a, "runs")[0]
	path := filepath.Join(t.TempDir(), "legacy")
	if _, e := repos.Git(ctx, r.Path, "worktree", "add", "-b", "legacy", path); e != nil {
		t.Fatal(e)
	}
	run.Worktrees = []domain.Worktree{{RepositoryID: r.ID, Path: path, Branch: "legacy", SetupDone: true, SetupCompleted: 2}}
	session := domain.Session{Meta: domain.NewMeta(), WorkspaceID: w.ID, RunID: run.ID, Role: "worker", Directory: path, State: "stopped"}
	run.SessionID = session.ID
	if e := a.Store.Tx(ctx, func(q storage.Queryer) error {
		if e := persist(ctx, q, run); e != nil {
			return e
		}
		return persist(ctx, q, session)
	}); e != nil {
		t.Fatal(e)
	}
	for n := 0; n < 2; n++ {
		if e := a.DiscoverWorktrees(ctx, r.ID); e != nil {
			t.Fatal(e)
		}
	}
	migrated, _ := storage.Get[domain.Run](ctx, a.Store.DB, "runs", run.ID)
	s, _ := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", session.ID)
	if migrated.Worktrees[0].ID == "" || !migrated.Worktrees[0].SetupDone || migrated.Worktrees[0].SetupCompleted != 2 || s.WorktreeID != migrated.Worktrees[0].ID || len(s.WorktreeIDs) != 1 {
		t.Fatal("migration lost links/setup", migrated, s)
	}
	if _, e := a.AddRepository(ctx, domain.Repository{WorkspaceID: w.ID, Path: path}, false); e == nil {
		t.Fatal("registered linked checkout as a duplicate repository")
	}
}

func TestWorkspaceAccountRequiresMatchingHost(t *testing.T) {
	a, w, r, _ := fixture(t)
	ctx := context.Background()
	i, e := a.SaveIntegration(ctx, domain.Integration{WorkspaceID: w.ID, Provider: "github", Enabled: true}, "fake")
	if e != nil {
		t.Fatal(e)
	}
	w.GitHubAccountID = i.ID
	if _, e = a.SaveWorkspace(ctx, w.ID, w); e != nil {
		t.Fatal(e)
	}
	r.Provider = "github"
	r.Remote = "https://github.com/org/repo.git"
	if got := a.RepositoryAccount(ctx, r); got != i.ID {
		t.Fatal("default account not used", got)
	}
	r.Remote = "https://elsewhere.example/org/repo.git"
	if got := a.RepositoryAccount(ctx, r); got != "" {
		t.Fatal("credential used for wrong host")
	}
}

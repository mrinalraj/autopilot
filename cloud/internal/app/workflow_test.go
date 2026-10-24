package app

import (
	"context"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
	"testing"
)

func TestAutomaticTriageLinksPlanAndPreservesApprovalBoundary(t *testing.T) {
	a, w, r, f := fixture(t)
	ctx := context.Background()
	issue, e := a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "Plan this", Status: "done", Priority: 4})
	if e != nil {
		t.Fatal(e)
	}
	if issue.Status != "backlog" || issue.Priority != 0 {
		t.Fatal("new issue skipped triage")
	}
	a.EnsureTriage(ctx)
	a.EnsureTriage(ctx)
	if f.starts != 1 {
		t.Fatal("duplicate coordinator", f.starts)
	}
	snap, _ := a.Snapshot(ctx)
	if snap.Issues[0].WorkflowDetail != "Planning" || snap.Issues[0].PlanningSessionID == "" {
		t.Fatal("not claimed", snap.Issues)
	}
	p := proposed(t, a, w, r, issue.ID)
	snap, _ = a.Snapshot(ctx)
	if snap.Issues[0].WorkflowState != "needs_you" || len(snap.Issues[0].PlanIDs) != 1 || snap.Issues[0].PlanIDs[0] != p.ID {
		t.Fatal("missing plan linkage", snap.Issues)
	}
	a.EnsureTriage(ctx)
	if len(records[domain.Run](t, a, "runs")) != 0 {
		t.Fatal("planning auto-approved execution")
	}
	if _, e = a.Approve(ctx, p.ID, p.Revision, "workflow"); e != nil {
		t.Fatal(e)
	}
	snap, _ = a.Snapshot(ctx)
	if snap.Issues[0].WorkflowState != "working" {
		t.Fatal(snap.Issues)
	}
	current, _ := storage.Get[domain.Issue](ctx, a.Store.DB, "issues", issue.ID)
	current.Status = "done"
	updated, e := a.UpdateIssue(ctx, current.ID, current)
	if e != nil || updated.Status == "done" {
		t.Fatal("manual edit changed automatic status", e)
	}
}
func TestOneCoordinatorPerWorkspaceAndStoppedStaysStopped(t *testing.T) {
	a, w, _, f := fixture(t)
	ctx := context.Background()
	one, e := a.Orchestrator(ctx, w.ID)
	if e != nil {
		t.Fatal(e)
	}
	same, e := a.Orchestrator(ctx, w.ID)
	if e != nil || one.ID != same.ID {
		t.Fatal("duplicate coordinator")
	}
	other, e := a.CreateWorkspace(ctx, domain.Workspace{Name: "Second"})
	if e != nil {
		t.Fatal(e)
	}
	two, e := a.Orchestrator(ctx, other.ID)
	if e != nil || two.WorkspaceID == one.WorkspaceID {
		t.Fatal("workspace coordinators incorrectly share global limit", e)
	}
	if e = a.SessionAction(ctx, one.ID, "stop", "", ""); e != nil {
		t.Fatal(e)
	}
	a.CreateIssue(ctx, domain.Issue{WorkspaceID: w.ID, Title: "Wait for restart"})
	a.EnsureTriage(ctx)
	if f.starts != 2 {
		t.Fatal("restarted explicitly stopped coordinator")
	}
}
func TestBoardNeverCompletesOnAgentExit(t *testing.T) {
	i := domain.Issue{Meta: domain.NewMeta(), Status: "in_progress"}
	r := domain.Run{Meta: domain.NewMeta(), Task: domain.Task{IssueID: i.ID}, State: "running", SessionID: "agent"}
	s := Snapshot{Issues: []domain.Issue{i}, Runs: []domain.Run{r}, Sessions: []domain.Session{{Meta: domain.Meta{ID: "agent"}, State: "exited"}}}
	projectWorkflow(&s)
	if s.Issues[0].WorkflowState != "needs_you" {
		t.Fatal(s.Issues)
	}
	s.Runs[0].State = "completed"
	projectWorkflow(&s)
	if s.Issues[0].WorkflowState != "done" {
		t.Fatal(s.Issues)
	}
}

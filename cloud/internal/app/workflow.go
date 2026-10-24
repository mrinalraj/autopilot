package app

import (
	"context"
	"fmt"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
	"slices"
)

// The board projects execution state; tracker statuses remain provider-owned.
func projectWorkflow(s *Snapshot) {
	for n := range s.Issues {
		i := &s.Issues[n]
		i.PlanIDs = []string{}
		i.WorkflowState = "triage"
		i.WorkflowDetail = "Waiting for coordinator"
		linked := map[string]bool{}
		draft := false
		for _, p := range s.Plans {
			match := p.IssueID == i.ID
			for _, t := range p.Tasks {
				match = match || t.IssueID == i.ID
			}
			if match {
				i.PlanIDs = append(i.PlanIDs, p.ID)
				linked[p.ID] = true
				draft = draft || p.State == "draft"
			}
		}
		if i.Status == "canceled" {
			i.WorkflowState = "done"
			i.WorkflowDetail = "Canceled"
			continue
		}
		if draft {
			i.WorkflowState = "needs_you"
			i.WorkflowDetail = "Plan ready for approval"
			continue
		}
		execution := map[string]bool{}
		for _, e := range s.Executions {
			if linked[e.PlanID] {
				execution[e.ID] = true
			}
		}
		own := []domain.Run{}
		for _, r := range s.Runs {
			if r.Task.IssueID == i.ID || execution[r.ExecutionID] {
				own = append(own, r)
			}
		}
		if len(own) == 0 {
			if i.Source != "native" && len(i.PlanIDs) == 0 {
				queued := false
				for _, q := range s.Queue {
					queued = queued || (q.IssueID == i.ID && q.State == "pending")
				}
				if !queued {
					i.WorkflowState = "untracked"
					i.WorkflowDetail = "Not queued for Autopilot"
					continue
				}
			}

			if i.Status == "done" {
				i.WorkflowState = "done"
				i.WorkflowDetail = "Completed"
				continue
			}
			if i.PlanningSessionID != "" {
				for _, co := range s.Sessions {
					if co.ID == i.PlanningSessionID {
						if live(co.State) && co.State != "needs_input" {
							i.WorkflowState = "working"
							i.WorkflowDetail = "Planning"
						} else {
							i.WorkflowState = "needs_you"
							i.WorkflowDetail = "Coordinator needs attention"
						}
					}
				}
			}
			continue
		}
		allDone, review, attention, allMerged := true, false, false, true
		for _, r := range own {
			allDone = allDone && (r.State == "completed" || r.State == "canceled")
			attention = attention || r.State == "failed"
			for _, session := range s.Sessions {
				if session.ID == r.SessionID {
					attention = attention || slices.Contains([]string{"needs_input", "resume_required", "exited", "stopped"}, session.State) && r.State != "completed" && r.State != "canceled"
				}
			}
			hasChange := false
			for _, c := range s.Changes {
				if c.RunID == r.ID {
					hasChange = true
					allMerged = allMerged && c.State == "merged"
					review = review || c.State == "open"
					attention = attention || (r.State != "completed" && r.State != "canceled" && (c.Checks == "failed" || c.Error != ""))
				}
			}
			allMerged = allMerged && hasChange
		}
		switch {
		case allDone:
			i.WorkflowState = "done"
			i.WorkflowDetail = "Completed"
			if allMerged {
				i.WorkflowDetail = "Merged"
			}
		case attention:
			i.WorkflowState = "needs_you"
			i.WorkflowDetail = "Agent or checks need attention"
		case review:
			i.WorkflowState = "in_review"
			i.WorkflowDetail = "Review pending"
		default:
			i.WorkflowState = "working"
			i.WorkflowDetail = "Working"
			if own[0].State == "queued" {
				i.WorkflowDetail = "Queued for execution"
			}
		}
	}
}

// Auto-start once per workspace, then queue each ticket exactly once for that
// coordinator. An explicitly stopped coordinator stays stopped until reopened.
func (a *App) EnsureTriage(ctx context.Context) {
	snap, e := a.Snapshot(ctx)
	if e != nil {
		return
	}
	for _, w := range snap.Workspaces {
		pending := []domain.Issue{}
		for _, i := range snap.Issues {
			if i.WorkspaceID != w.ID || len(i.PlanIDs) > 0 || i.Status == "done" || i.Status == "canceled" {
				continue
			}
			eligible := i.Source == "native"
			for _, q := range snap.Queue {
				eligible = eligible || (q.IssueID == i.ID && q.State == "pending")
			}
			if eligible {
				pending = append(pending, i)
			}
		}
		if len(pending) == 0 {
			continue
		}
		hasRepo := false
		for _, r := range snap.Repositories {
			hasRepo = hasRepo || r.WorkspaceID == w.ID
		}
		if !hasRepo {
			continue
		}
		var co domain.Session
		hasHistory := false
		for _, s := range snap.Sessions {
			if s.WorkspaceID == w.ID && s.Role == "orchestrator" {
				hasHistory = true
				if live(s.State) {
					co = s
				}
			}
		}
		fresh := false
		if co.ID == "" {
			if hasHistory {
				continue
			}
			co, e = a.Orchestrator(ctx, w.ID)
			if e != nil {
				continue
			}
			fresh = true
		}
		for _, issue := range pending {
			if issue.PlanningSessionID == co.ID {
				continue
			}
			e = a.Store.Tx(ctx, func(q storage.Queryer) error {
				current, e := storage.Get[domain.Issue](ctx, q, "issues", issue.ID)
				if e != nil {
					return e
				}
				if current.PlanningSessionID == co.ID {
					return nil
				}
				if !fresh {
					action := domain.Action{Meta: domain.NewMeta(), Kind: "orchestrator.followup", EntityID: co.ID, State: "pending", Fingerprint: "triage:" + co.ID + ":" + issue.ID, Body: fmt.Sprintf("Triage %s (%s) in workspace %s. Read `autopilot snapshot`; inspect the code and propose a plan with this issueId unless it already has a plan. Do not start workers before approval. When finished, run `autopilot report --state idle --message 'Ready for triage'` as your final tool call.", issue.Identifier, issue.ID, w.ID)}
					if e = persist(ctx, q, action); e != nil {
						return e
					}
				}
				current.PlanningSessionID = co.ID
				current.Touch()
				if e = persist(ctx, q, current); e != nil {
					return e
				}
				return storage.Event(ctx, q, current.ID, "issue.planning", "Sent to workspace coordinator")
			})
			if e != nil {
				continue
			}
		}
	}
	actions, e := storage.List[domain.Action](ctx, a.Store.DB, "actions")
	if e != nil {
		return
	}
	for _, action := range actions {
		if action.Kind == "orchestrator.followup" && action.State == "pending" {
			a.deliverOrchestrator(ctx, action)
		}
	}
}

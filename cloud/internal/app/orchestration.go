package app

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

// Queue structured event summaries once. They remain visible in the outbox for
// harnesses without native readiness, and survive both app and agent restarts.
func (a *App) QueueOrchestratorEvents(ctx context.Context) {
	snap, err := a.Snapshot(ctx)
	if err != nil {
		return
	}
	for _, s := range snap.Sessions {
		if s.Role != "orchestrator" || !live(s.State) {
			continue
		}
		owned := map[string]bool{}
		for _, v := range snap.Issues {
			if v.WorkspaceID == s.WorkspaceID {
				owned[v.ID] = true
			}
		}
		for _, v := range snap.Plans {
			if v.WorkspaceID == s.WorkspaceID {
				owned[v.ID] = true
			}
		}
		for _, v := range snap.Runs {
			if v.WorkspaceID == s.WorkspaceID {
				owned[v.ID] = true
			}
		}
		for _, v := range snap.Sessions {
			if v.WorkspaceID == s.WorkspaceID && v.Role == "worker" {
				owned[v.ID] = true
			}
		}
		for _, v := range snap.Changes {
			if owned[v.RunID] {
				owned[v.ID] = true
			}
		}
		for _, v := range snap.Integrations {
			if v.WorkspaceID == s.WorkspaceID {
				owned[v.ID] = true
			}
		}
		events, err := a.Store.Events(ctx, s.EventCursor)
		if err != nil || len(events) == 0 {
			continue
		}
		messages := []string{}
		for _, e := range events {
			if owned[e.EntityID] && slices.Contains([]string{"issue.canceled", "sync.changed", "run.complete", "run.cancel", "run.failed", "agent.idle", "agent.needs_input", "session.attention", "change.observed", "change.created", "change.error"}, e.Kind) {
				messages = append(messages, fmt.Sprintf("- %s (%s): %s", e.Kind, e.EntityID, e.Message))
			}
		}
		cursor := events[len(events)-1].Sequence
		err = a.Store.Tx(ctx, func(q storage.Queryer) error {
			current, e := storage.Get[domain.Session](ctx, q, "sessions", s.ID)
			if e != nil {
				return e
			}
			if current.EventCursor != s.EventCursor {
				return nil
			}
			if len(messages) > 0 {
				action := domain.Action{Meta: domain.NewMeta(), Kind: "orchestrator.followup", EntityID: s.ID, State: "pending", Fingerprint: fmt.Sprintf("orchestrator:%s:%d", s.ID, cursor), Body: "Workspace updates:\n" + strings.Join(messages, "\n") + "\n\nInspect `autopilot snapshot` and coordinate within approved plans. Propose a new plan for additional scope. After handling updates, report idle as your final tool call. Plan approval and merging require human action."}
				if e = persist(ctx, q, action); e != nil {
					return e
				}
				if e = storage.Event(ctx, q, s.ID, "orchestrator.queued", "Workspace updates queued for orchestrator"); e != nil {
					return e
				}
			}
			current.EventCursor = cursor
			current.Touch()
			return persist(ctx, q, current)
		})
		if err != nil {
			return
		}
	}
}

func (a *App) deliverOrchestrator(ctx context.Context, action domain.Action) {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	current, err := storage.Get[domain.Action](ctx, a.Store.DB, "actions", action.ID)
	if err != nil || current.State != "pending" {
		return
	}
	action = current
	s, err := storage.Get[domain.Session](ctx, a.Store.DB, "sessions", action.EntityID)
	if err != nil || s.Role != "orchestrator" {
		return
	}
	if s.State != "idle" || (s.SignalSource != "native-hook" && s.SignalSource != "agent") {
		return
	}
	at, err := time.Parse(time.RFC3339Nano, s.SignalAt)
	if err != nil || time.Since(at) < 2*time.Second {
		return
	}
	i, err := a.Launcher.Inspect(ctx, s.Handle)
	if err != nil || !i.Exists || i.Dead {
		return
	}
	action.State = "delivering"
	action.Touch()
	s.State = "working"
	s.SignalSource = "runner"
	s.SignalAt = domain.Now()
	s.Touch()
	if err = a.Store.Tx(ctx, func(q storage.Queryer) error {
		if e := persist(ctx, q, s); e != nil {
			return e
		}
		return persist(ctx, q, action)
	}); err != nil {
		return
	}
	if err = a.Launcher.Send(ctx, s.Handle, action.Body); err != nil {
		action.State = "uncertain"
		action.Error = err.Error()
	} else {
		action.State = "delivered"
	}
	action.Touch()
	a.save(ctx, action, action.ID, "action."+action.State, "Orchestrator update "+action.State)
}

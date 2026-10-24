package app

import (
	"context"
	"fmt"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

type WorktreeReview struct {
	Change       domain.ChangeRequest `json:"change"`
	Mergeability string               `json:"mergeability"`
	Comments     []domain.Feedback    `json:"comments"`
}

func (a *App) ReviewWorktree(ctx context.Context, id string) (WorktreeReview, error) {
	out := WorktreeReview{Mergeability: "unknown", Comments: []domain.Feedback{}}
	w, e := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", id)
	if e != nil {
		return out, e
	}
	r, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", w.RepositoryID)
	if e != nil {
		return out, e
	}
	account := a.RepositoryAccount(ctx, r)
	if account == "" {
		return out, fmt.Errorf("choose a matching Git provider account in workspace settings")
	}
	i, e := storage.Get[domain.Integration](ctx, a.Store.DB, "integrations", account)
	if e != nil {
		return out, e
	}
	c, e := a.provider(i)
	if e != nil {
		return out, e
	}
	out.Change, e = c.Observe(ctx, i, r, domain.Run{Worktrees: []domain.Worktree{w}})
	if e != nil {
		return out, e
	}
	if out.Change.State == "missing" {
		return out, nil
	}
	out.Mergeability, e = c.Mergeability(ctx, i, r, out.Change.Number)
	if e != nil {
		return out, e
	}
	out.Comments, e = c.Comments(ctx, i, r, out.Change.Number)
	return out, e
}

package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

type WorkspaceScan struct {
	Root         string   `json:"root"`
	Repositories []string `json:"repositories"`
}

// ScanWorkspace reads an existing directory without creating any app records.
func (a *App) ScanWorkspace(ctx context.Context, root string) (WorkspaceScan, error) {
	var result WorkspaceScan
	if strings.TrimSpace(root) == "" {
		return result, fmt.Errorf("workspace directory is required")
	}
	if root == "~" || strings.HasPrefix(root, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return result, err
		}
		if root == "~" {
			root = home
		} else {
			root = filepath.Join(home, strings.TrimPrefix(root, "~/"))
		}
	}
	var err error
	result.Root, err = repos.CanonicalPath(root)
	if err != nil {
		return result, err
	}
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	result.Repositories, err = repos.Discover(ctx, result.Root)
	if err != nil {
		return result, err
	}
	// A single repository can also serve as a workspace.
	if _, _, err := repos.Inspect(ctx, result.Root); err == nil {
		result.Repositories = append([]string{result.Root}, result.Repositories...)
	}
	return result, nil
}

func inspectRepository(ctx context.Context, r domain.Repository) (domain.Repository, error) {
	var err error
	r.Path, err = repos.CanonicalPath(r.Path)
	if err != nil {
		return r, err
	}
	r.CommonDir, err = repos.Git(ctx, r.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return r, err
	}
	r.CommonDir, err = repos.CanonicalPath(r.CommonDir)
	if err != nil {
		return r, err
	}
	r.Remote, r.DefaultBranch, err = repos.Inspect(ctx, r.Path)
	if err != nil {
		return r, err
	}
	r.Meta = domain.NewMeta()
	if r.Name == "" {
		r.Name = filepath.Base(r.Path)
	}
	if r.Remote != "" {
		_, detected, providerRepo, err := repos.Remote(r.Remote)
		if err != nil {
			return r, err
		}
		if r.Provider == "" {
			r.Provider = detected
		}
		r.ProviderRepo = providerRepo
	} else {
		r.Provider = "git"
	}
	return r, nil
}

// ImportWorkspace registers the selected repositories atomically. Files stay
// where they are; importing never clones, moves or modifies a repository.
func (a *App) ImportWorkspace(ctx context.Context, w domain.Workspace, paths []string) (domain.Workspace, error) {
	scan, err := a.ScanWorkspace(ctx, w.Root)
	if err != nil {
		return w, err
	}
	w.Root = scan.Root
	w, err = a.prepareWorkspace(w)
	if err != nil {
		return w, err
	}
	allowed := map[string]bool{}
	for _, path := range scan.Repositories {
		canonical, err := repos.CanonicalPath(path)
		if err != nil {
			return w, err
		}
		allowed[canonical] = true
	}
	selected := []domain.Repository{}
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	for _, path := range paths {
		canonical, err := repos.CanonicalPath(path)
		if err != nil {
			return w, err
		}
		if !allowed[canonical] {
			return w, fmt.Errorf("select each repository once from the scanned workspace directory")
		}
		delete(allowed, canonical)
		r, err := inspectRepository(ctx, domain.Repository{WorkspaceID: w.ID, Path: canonical})
		if err != nil {
			return w, err
		}
		selected = append(selected, r)
	}
	err = a.Store.Tx(ctx, func(q storage.Queryer) error {
		var count int
		if err := q.QueryRowContext(ctx, "SELECT count(*) FROM workspaces WHERE root=?", w.Root).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("this directory is already registered as a workspace")
		}
		if err := persist(ctx, q, w); err != nil {
			return err
		}
		for _, r := range selected {
			if err := uniqueRepository(ctx, q, r); err != nil {
				return err
			}
			if err := q.QueryRowContext(ctx, "SELECT count(*) FROM repositories WHERE path=?", r.Path).Scan(&count); err != nil {
				return err
			}
			if count > 0 {
				return fmt.Errorf("repository is already registered: %s", r.Path)
			}
			if err := persist(ctx, q, r); err != nil {
				return err
			}
		}
		return storage.Event(ctx, q, w.ID, "workspace.imported", fmt.Sprintf("Imported %s with %d repositories", w.Name, len(selected)))
	})
	if err == nil {
		err = a.DiscoverWorktrees(ctx, "")
	}
	return w, err
}

// RemoveWorkspace deletes local tracking records only. Repository directories
// and worktrees are deliberately retained, including uncommitted work.
func (a *App) RemoveWorkspace(ctx context.Context, id string, revision int) error {
	// Match existing lock ordering: provider observation and action delivery can
	// enter Operations, so acquire those locks before the runner lock.
	a.IntegrationOps.Lock()
	defer a.IntegrationOps.Unlock()
	a.ChangesOps.Lock()
	defer a.ChangesOps.Unlock()
	a.ActionOps.Lock()
	defer a.ActionOps.Unlock()
	a.Operations.Lock()
	defer a.Operations.Unlock()
	var sessions []domain.Session
	var integrationIDs []string
	err := a.Store.Tx(ctx, func(q storage.Queryer) error {
		w, err := storage.Get[domain.Workspace](ctx, q, "workspaces", id)
		if err != nil {
			return err
		}
		if w.Revision != revision {
			return fmt.Errorf("workspace changed; refresh and retry")
		}
		runs, err := storage.List[domain.Run](ctx, q, "runs")
		if err != nil {
			return err
		}
		for _, r := range runs {
			if r.WorkspaceID == id && r.State != "completed" && r.State != "canceled" {
				return fmt.Errorf("cancel or complete this workspace's runs before removing it")
			}
		}
		allSessions, err := storage.List[domain.Session](ctx, q, "sessions")
		if err != nil {
			return err
		}
		for _, s := range allSessions {
			if s.WorkspaceID != id {
				continue
			}
			if live(s.State) {
				return fmt.Errorf("stop this workspace's agent sessions before removing it")
			}
			sessions = append(sessions, s)
		}
		// Gather ownership before deleting anything. All predicates are internal
		// constants, ordered so children are removed before their foreign keys.
		tables := []struct{ name, predicate string }{
			{"changes", "run_id IN (SELECT runs.id FROM runs JOIN executions ON executions.id=runs.execution_id JOIN plans ON plans.id=executions.plan_id WHERE plans.workspace_id=?)"},
			{"sessions", "workspace_id=?"},
			{"runs", "execution_id IN (SELECT executions.id FROM executions JOIN plans ON plans.id=executions.plan_id WHERE plans.workspace_id=?)"},
			{"executions", "plan_id IN (SELECT id FROM plans WHERE workspace_id=?)"},
			{"plans", "workspace_id=?"},
			{"queue", "workspace_id=?"},
			{"comments", "issue_id IN (SELECT id FROM issues WHERE workspace_id=?)"},
			{"issues", "workspace_id=?"},
			{"projects", "workspace_id=?"},
			{"worktrees", "workspace_id=?"},
			{"repositories", "workspace_id=?"},
			{"integrations", "workspace_id=?"},
			{"workspaces", "id=?"},
		}
		owned := map[string]bool{}
		for _, table := range tables {
			rows, err := q.QueryContext(ctx, "SELECT id FROM "+table.name+" WHERE "+table.predicate, id)
			if err != nil {
				return err
			}
			for rows.Next() {
				var entity string
				if err := rows.Scan(&entity); err != nil {
					rows.Close()
					return err
				}
				owned[entity] = true
				if table.name == "integrations" {
					integrationIDs = append(integrationIDs, entity)
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
		actions, err := storage.List[domain.Action](ctx, q, "actions")
		if err != nil {
			return err
		}
		for _, action := range actions {
			if !owned[action.EntityID] && !owned[action.IntegrationID] {
				continue
			}
			if action.State == "delivering" {
				return fmt.Errorf("resolve the in-flight action before removing this workspace")
			}
			if _, err := q.ExecContext(ctx, "DELETE FROM actions WHERE id=?", action.ID); err != nil {
				return err
			}
			owned[action.ID] = true
		}
		if _, err := q.ExecContext(ctx, "DELETE FROM webhook_receipts WHERE integration_id IN (SELECT id FROM integrations WHERE workspace_id=?)", id); err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, "DELETE FROM run_worktrees WHERE worktree_id IN (SELECT id FROM worktrees WHERE workspace_id=?)", id); err != nil {
			return err
		}
		for _, table := range tables {
			if _, err := q.ExecContext(ctx, "DELETE FROM "+table.name+" WHERE "+table.predicate, id); err != nil {
				return err
			}
		}
		for entity := range owned {
			if _, err := q.ExecContext(ctx, "DELETE FROM events WHERE entity_id=?", entity); err != nil {
				return err
			}
		}
		// A minimal tombstone refreshes other open browsers after the old history
		// is deleted. It contains no workspace name, paths or issue content.
		return storage.Event(ctx, q, id, "workspace.removed", "Workspace removed; code files retained")
	})
	if err != nil {
		return err
	}
	// These are app-owned credentials and launch files, never source directories.
	remove := func(path string) {
		if err := os.RemoveAll(path); err != nil {
			slog.Warn("removed workspace artifact cleanup", "path", path, "error", err)
		}
	}
	for _, id := range integrationIDs {
		remove(filepath.Join(a.Config.DataDir, "secrets", "integration-"+id))
		remove(filepath.Join(a.Config.DataDir, "secrets", "webhook-"+id))
	}
	for _, s := range sessions {
		if a.Launcher != nil {
			if err := a.Launcher.Stop(ctx, s.Handle); err != nil {
				slog.Warn("removed workspace session cleanup", "error", err)
			}
		}
		remove(filepath.Join(a.Config.DataDir, "sessions", s.ID))
		files, _ := filepath.Glob(filepath.Join(a.Config.DataDir, "secrets", "session-"+s.ID+"-*"))
		for _, file := range files {
			remove(file)
		}
	}
	return nil
}

// Linked checkouts belong under one repository, rather than duplicate sidebar roots.
func uniqueRepository(ctx context.Context, q storage.Queryer, r domain.Repository) error {
	all, e := storage.List[domain.Repository](ctx, q, "repositories")
	if e != nil {
		return e
	}
	for _, old := range all {
		if old.ID == r.ID {
			continue
		}
		common := old.CommonDir
		if common == "" {
			common, _ = repos.Git(ctx, old.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
			if p, e := repos.CanonicalPath(common); e == nil {
				common = p
			}
		}
		if old.Path == r.Path || (common != "" && common == r.CommonDir) {
			return fmt.Errorf("this Git repository is already registered as %s; rescan its worktrees instead", old.Name)
		}
	}
	return nil
}

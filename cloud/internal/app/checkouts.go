package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

// Callers holding Operations use discoverWorktrees directly.
func (a *App) DiscoverWorktrees(ctx context.Context, repositoryID string) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	return a.discoverWorktrees(ctx, repositoryID)
}
func (a *App) discoverWorktrees(ctx context.Context, repositoryID string) error {
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	registered, err := storage.List[domain.Repository](ctx, a.Store.DB, "repositories")
	if err != nil {
		return err
	}
	for _, repo := range registered {
		if repositoryID != "" && repo.ID != repositoryID {
			continue
		}
		actual, scanErr := repos.ListWorktrees(ctx, repo.Path)
		if scanErr != nil {
			if repositoryID != "" {
				return scanErr
			}
			continue
		}
		err = a.Store.Tx(ctx, func(q storage.Queryer) error {
			stored, e := storage.List[domain.Worktree](ctx, q, "worktrees")
			if e != nil {
				return e
			}
			byPath := map[string]domain.Worktree{}
			for _, w := range stored {
				byPath[w.Path] = w
			}
			seen := map[string]bool{}
			for _, git := range actual {
				w, exists := byPath[git.Path]
				if exists && w.RepositoryID != repo.ID {
					continue
				} // A Git checkout has one owner.
				old := w
				if !exists {
					w = domain.Worktree{Meta: domain.NewMeta(), WorkspaceID: repo.WorkspaceID, RepositoryID: repo.ID, Name: filepath.Base(git.Path), Path: git.Path, Origin: "discovered", IssueIDs: []string{}}
				}
				w.Branch = git.Branch
				w.Head = git.Head
				w.Primary = git.Primary
				w.Status = "present"
				if _, e := os.Stat(w.Path); e != nil {
					w.Status = "missing"
				}
				if w.Primary {
					w.Name = "(default)"
				}
				seen[w.ID] = true
				byPath[w.Path] = w
				if !reflect.DeepEqual(old, w) {
					if exists {
						w.Touch()
					}
					if e := persist(ctx, q, w); e != nil {
						return e
					}
					if e := storage.Event(ctx, q, w.ID, "worktree.discovered", "Updated "+w.Name); e != nil {
						return e
					}
				}
			}
			for _, w := range stored {
				if w.RepositoryID == repo.ID && !seen[w.ID] && w.Status != "missing" && w.Status != "removed" {
					w.Status = "missing"
					w.Touch()
					if e := persist(ctx, q, w); e != nil {
						return e
					}
					if e := storage.Event(ctx, q, w.ID, "worktree.missing", "Worktree is no longer registered in Git"); e != nil {
						return e
					}
				}
			}
			// Migrate run snapshots and sessions in place. No Git mutation is needed.
			runs, e := storage.List[domain.Run](ctx, q, "runs")
			if e != nil {
				return e
			}
			for _, run := range runs {
				changed := false
				for n, legacy := range run.Worktrees {
					if legacy.RepositoryID != repo.ID {
						continue
					}
					path := legacy.Path
					if canonical, e := repos.CanonicalPath(path); e == nil {
						path = canonical
					}
					w, exists := byPath[path]
					if !exists {
						w = domain.Worktree{Meta: domain.NewMeta(), WorkspaceID: repo.WorkspaceID, RepositoryID: repo.ID, Name: legacy.Branch, Path: path, Branch: legacy.Branch, Origin: "run", Status: "missing"}
					}
					if w.Origin == "discovered" {
						w.Origin = "run"
						w.Name = legacy.Branch
					}
					if legacy.ID != w.ID {
						run.Worktrees[n].Meta = w.Meta
						changed = true
					}
					if run.Task.IssueID != "" && !slices.Contains(w.IssueIDs, run.Task.IssueID) {
						w.IssueIDs = append(w.IssueIDs, run.Task.IssueID)
					}
					if e := persist(ctx, q, w); e != nil {
						return e
					}
					byPath[path] = w
					if _, e := q.ExecContext(ctx, "INSERT OR IGNORE INTO run_worktrees(run_id,worktree_id) VALUES(?,?)", run.ID, w.ID); e != nil {
						return e
					}
				}
				if changed {
					if e := persist(ctx, q, run); e != nil {
						return e
					}
				}
			}
			runs, e = storage.List[domain.Run](ctx, q, "runs")
			if e != nil {
				return e
			}
			sessions, e := storage.List[domain.Session](ctx, q, "sessions")
			if e != nil {
				return e
			}
			for _, s := range sessions {
				if s.WorkspaceID != repo.WorkspaceID || s.Role == "orchestrator" {
					continue
				}
				before := s
				path := s.Directory
				if canonical, e := repos.CanonicalPath(path); e == nil {
					path = canonical
				}
				if w, ok := byPath[path]; ok {
					s.WorktreeID = w.ID
					s.WorktreeIDs = []string{w.ID}
					if s.Kind == "" {
						s.Kind = "agent"
					}
					if s.RunID != "" {
						for _, run := range runs {
							if run.ID == s.RunID {
								for _, rw := range run.Worktrees {
									if rw.ID != "" && !slices.Contains(s.WorktreeIDs, rw.ID) {
										s.WorktreeIDs = append(s.WorktreeIDs, rw.ID)
									}
								}
							}
						}
					}
					if reflect.DeepEqual(before, s) {
						continue
					}
					if e := persist(ctx, q, s); e != nil {
						return e
					}
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

type NewWorktree struct {
	Name    string `json:"name"`
	Branch  string `json:"branch"`
	Base    string `json:"base"`
	IssueID string `json:"issueId"`
}

func (a *App) CreateWorktree(ctx context.Context, repoID, key string, req NewWorktree) (domain.Worktree, error) {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	var w domain.Worktree
	repo, err := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", repoID)
	if err != nil {
		return w, err
	}
	if strings.TrimSpace(req.Name) == "" || len(req.Name) > 120 || key == "" {
		return w, fmt.Errorf("name and request key are required")
	}
	all, err := storage.List[domain.Worktree](ctx, a.Store.DB, "worktrees")
	if err != nil {
		return w, err
	}
	for _, old := range all {
		if old.RequestKey == key {
			if old.RepositoryID != repoID || old.Name != req.Name || old.Branch != req.Branch || old.Base != req.Base || (req.IssueID != "" && !slices.Contains(old.IssueIDs, req.IssueID)) {
				return w, fmt.Errorf("request key already used")
			}
			if old.Status != "present" {
				return old, fmt.Errorf("previous creation is %s; inspect the worktree before retrying", old.Status)
			}
			return old, nil
		}
	}
	if req.IssueID != "" {
		i, e := storage.Get[domain.Issue](ctx, a.Store.DB, "issues", req.IssueID)
		if e != nil || i.WorkspaceID != repo.WorkspaceID {
			return w, fmt.Errorf("choose an issue in this workspace")
		}
	}
	w = domain.Worktree{Meta: domain.NewMeta(), WorkspaceID: repo.WorkspaceID, RepositoryID: repoID, Name: req.Name, Branch: req.Branch, Base: req.Base, Origin: "manual", Pinned: true, Status: "creating", RequestKey: key, IssueIDs: []string{}}
	if req.IssueID != "" {
		w.IssueIDs = append(w.IssueIDs, req.IssueID)
	}
	w.Path = filepath.Join(a.Config.DataDir, "worktrees", repo.ID, w.ID)
	if err = os.MkdirAll(filepath.Dir(w.Path), 0700); err != nil {
		return w, err
	}
	if err = a.save(ctx, w, w.ID, "worktree.creating", "Creating "+w.Name); err != nil {
		return w, err
	}
	if err = repos.CreateWorktree(ctx, repo.Path, w.Path, w.Branch, w.Base); err != nil {
		if _, stat := os.Stat(w.Path); os.IsNotExist(stat) {
			a.Store.DB.ExecContext(ctx, "DELETE FROM worktrees WHERE id=?", w.ID)
		} else {
			w.Status = "error"
			a.save(ctx, w, w.ID, "worktree.error", err.Error())
		}
		return w, err
	}
	w.Path, _ = repos.CanonicalPath(w.Path)
	w.Status = "present"
	w.Head, _ = repos.Git(ctx, w.Path, "rev-parse", "HEAD")
	w.Touch()
	return w, a.save(ctx, w, w.ID, "worktree.created", "Created "+w.Name)
}
func (a *App) WorktreeAction(ctx context.Context, id, action string, revision int) error {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	w, err := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", id)
	if err != nil {
		return err
	}
	if w.Revision != revision {
		return fmt.Errorf("worktree changed; refresh and retry")
	}
	switch action {
	case "pin":
		w.Pinned = !w.Pinned
	case "restore":
		w.Hidden = false
	case "unregister", "remove":
		if w.Primary {
			return fmt.Errorf("the primary checkout cannot be removed or hidden")
		}
		if err = a.worktreeBusy(ctx, w); err != nil {
			return err
		}
		if action == "remove" {
			repo, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", w.RepositoryID)
			if e != nil {
				return e
			}
			risk, e := repos.Risk(ctx, w.Path)
			if e != nil {
				return e
			}
			if risk != "" {
				return fmt.Errorf("removal refused: %s", risk)
			}
			if _, e = repos.Git(ctx, repo.Path, "worktree", "remove", "--", w.Path); e != nil {
				return e
			}
			w.Status = "removed"
		}
		w.Hidden = true
	default:
		return fmt.Errorf("unsupported worktree action")
	}
	w.Touch()
	return a.save(ctx, w, w.ID, "worktree."+action, "Worktree "+action)
}
func (a *App) worktreeBusy(ctx context.Context, w domain.Worktree) error {
	sessions, e := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
	if e != nil {
		return e
	}
	for _, s := range sessions {
		if live(s.State) && (s.WorktreeID == w.ID || s.Directory == w.Path || slices.Contains(s.WorktreeIDs, w.ID)) {
			return fmt.Errorf("stop worktree terminals and agents first")
		}
	}
	runs, e := storage.List[domain.Run](ctx, a.Store.DB, "runs")
	if e != nil {
		return e
	}
	for _, r := range runs {
		if r.State == "completed" || r.State == "canceled" {
			continue
		}
		for _, rw := range r.Worktrees {
			if rw.ID == w.ID || rw.Path == w.Path {
				return fmt.Errorf("complete or cancel the associated run first")
			}
		}
	}
	return nil
}
func (a *App) RepositoryInfo(ctx context.Context, id, action string) (any, error) {
	repo, e := storage.Get[domain.Repository](ctx, a.Store.DB, "repositories", id)
	if e != nil {
		return nil, e
	}
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	if action == "fetch" {
		a.Operations.Lock()
		defer a.Operations.Unlock()
		_, e = repos.Git(ctx, repo.Path, "fetch", "--prune", "origin")
		if e != nil {
			return nil, e
		}
	}
	return repos.Branches(ctx, repo.Path)
}
func (a *App) WorktreeChanges(ctx context.Context, id string) (any, error) {
	w, e := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", id)
	if e != nil {
		return nil, e
	}
	ctx = repos.WithEnvironment(ctx, a.baseEnv())
	status, e := repos.Git(ctx, w.Path, "status", "--short")
	if e != nil {
		return nil, e
	}
	if _, headErr := repos.Git(ctx, w.Path, "rev-parse", "--verify", "HEAD"); headErr != nil {
		return map[string]string{"status": status, "diff": ""}, nil
	}
	diff, e := repos.Git(ctx, w.Path, "diff", "--stat", "HEAD")
	if e != nil {
		return nil, e
	}
	return map[string]string{"status": status, "diff": diff}, nil
}
func (a *App) LinkWorktreeIssue(ctx context.Context, id, issueID string) error {
	return a.Store.Tx(ctx, func(q storage.Queryer) error {
		w, e := storage.Get[domain.Worktree](ctx, q, "worktrees", id)
		if e != nil {
			return e
		}
		i, e := storage.Get[domain.Issue](ctx, q, "issues", issueID)
		if e != nil || i.WorkspaceID != w.WorkspaceID {
			return fmt.Errorf("issue must belong to this workspace")
		}
		if !slices.Contains(w.IssueIDs, i.ID) {
			w.IssueIDs = append(w.IssueIDs, i.ID)
			w.Touch()
		}
		if e = persist(ctx, q, w); e != nil {
			return e
		}
		return storage.Event(ctx, q, w.ID, "worktree.linked", "Linked "+i.Identifier)
	})
}

func (a *App) StartWorktreeSession(ctx context.Context, id, kind, harness, prompt string) (domain.Session, error) {
	a.Operations.Lock()
	defer a.Operations.Unlock()
	var s domain.Session
	w, e := storage.Get[domain.Worktree](ctx, a.Store.DB, "worktrees", id)
	if e != nil {
		return s, e
	}
	if w.Status != "present" {
		return s, fmt.Errorf("worktree is unavailable; rescan the repository")
	}
	profile := domain.HarnessProfile{ID: "shell", Label: "Terminal", Command: "/bin/sh", Args: []string{"-i"}, PromptMode: "none"}
	role := "shell"
	if kind == "agent" {
		role = "worker"
		profile, e = a.Plugins.Profile(harness)
		if e != nil {
			return s, e
		}
		sessions, e := storage.List[domain.Session](ctx, a.Store.DB, "sessions")
		if e != nil {
			return s, e
		}
		count := 0
		for _, v := range sessions {
			if v.Role == "worker" && live(v.State) {
				count++
			}
		}
		if count >= a.Config.MaxWorkers {
			return s, fmt.Errorf("worker concurrency limit reached")
		}
	} else if kind != "shell" {
		return s, fmt.Errorf("choose terminal or agent")
	}
	s = domain.Session{Meta: domain.NewMeta(), Kind: kind, WorktreeID: w.ID, WorktreeIDs: []string{w.ID}, WorkspaceID: w.WorkspaceID, Role: role, Harness: profile, Directory: w.Path, Generation: domain.ID(), State: "starting", Prompt: prompt, SignalSource: "runner", SignalAt: domain.Now()}
	s.Handle = "ap-" + s.ID
	if e = a.save(ctx, s, s.ID, "session.created", "Opening "+profile.Label); e != nil {
		return s, e
	}
	if e = a.startSession(ctx, &s); e != nil {
		s.State = "stopped"
		s.Error = e.Error()
		s.Touch()
		a.save(ctx, s, s.ID, "session.failed", s.Error)
	}
	return s, e
}

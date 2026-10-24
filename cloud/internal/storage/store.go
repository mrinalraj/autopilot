package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB          *sql.DB
	mu          sync.Mutex
	subscribers map[chan struct{}]struct{}
}
type Queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

var tables = map[string]bool{"workspaces": true, "repositories": true, "worktrees": true, "queue": true, "projects": true, "issues": true, "comments": true, "plans": true, "executions": true, "runs": true, "sessions": true, "integrations": true, "changes": true, "actions": true}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "autopilot.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db, subscribers: map[chan struct{}]struct{}{}}
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		db.Close()
		return nil, err
	}
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) View(ctx context.Context, fn func(Queryer) error) error {
	tx, e := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = fn(tx); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) Tx(ctx context.Context, fn func(Queryer) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.Notify()
	}
	return err
}
func Get[T any](ctx context.Context, q Queryer, table, id string) (T, error) {
	var v T
	if !tables[table] {
		return v, fmt.Errorf("invalid table")
	}
	var data string
	err := q.QueryRowContext(ctx, "SELECT data FROM "+table+" WHERE id=?", id).Scan(&data)
	if err == nil {
		err = json.Unmarshal([]byte(data), &v)
	}
	return v, err
}
func List[T any](ctx context.Context, q Queryer, table string) ([]T, error) {
	if !tables[table] {
		return nil, fmt.Errorf("invalid table")
	}
	rows, err := q.QueryContext(ctx, "SELECT data FROM "+table+" ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var data string
		var v T
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(data), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Save keeps identity/foreign keys queryable and stores versioned typed payloads.
// Column names are internal constants; values always use bound parameters.
func Save(ctx context.Context, q Queryer, table, id string, value any, refs ...any) error {
	if !tables[table] || len(refs)%2 != 0 {
		return fmt.Errorf("invalid save")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	cols := []string{"id", "data"}
	marks := []string{"?", "?"}
	updates := []string{"data=excluded.data"}
	args := []any{id, string(b)}
	for i := 0; i < len(refs); i += 2 {
		col, ok := refs[i].(string)
		if !ok || strings.ContainsAny(col, " ;'\"") {
			return fmt.Errorf("invalid column")
		}
		cols = append(cols, col)
		marks = append(marks, "?")
		updates = append(updates, col+"=excluded."+col)
		args = append(args, refs[i+1])
	}
	_, err = q.ExecContext(ctx, "INSERT INTO "+table+" ("+strings.Join(cols, ",")+") VALUES ("+strings.Join(marks, ",")+") ON CONFLICT(id) DO UPDATE SET "+strings.Join(updates, ","), args...)
	return err
}
func Event(ctx context.Context, q Queryer, id, kind, message string) error {
	_, err := q.ExecContext(ctx, "INSERT INTO events(at,entity_id,kind,message) VALUES(?,?,?,?)", domain.Now(), id, kind, message)
	return err
}
func (s *Store) Events(ctx context.Context, after int64) ([]domain.Event, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT sequence,at,entity_id,kind,message FROM events WHERE sequence>? ORDER BY sequence LIMIT 500", after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Event{}
	for rows.Next() {
		var e domain.Event
		if err = rows.Scan(&e.Sequence, &e.At, &e.EntityID, &e.Kind, &e.Message); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (s *Store) Subscribe() (chan struct{}, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan struct{}, 1)
	s.subscribers[ch] = struct{}{}
	return ch, func() { s.mu.Lock(); delete(s.subscribers, ch); s.mu.Unlock() }
}
func (s *Store) Notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subscribers {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}
func Null(s string) any {
	if s == "" {
		return nil
	}
	return s
}

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL, root TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id));
CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id));
CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT REFERENCES projects(id), parent_id TEXT REFERENCES issues(id), external_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, data TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id), external_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), issue_id TEXT REFERENCES issues(id));
CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, data TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id), plan_revision INTEGER NOT NULL, request_key TEXT NOT NULL UNIQUE, UNIQUE(plan_id,plan_revision));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id), task_id TEXT NOT NULL, issue_id TEXT REFERENCES issues(id), active INTEGER NOT NULL DEFAULT 1, UNIQUE(execution_id,task_id));
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_issue ON runs(issue_id) WHERE active=1 AND issue_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), run_id TEXT REFERENCES runs(id), handle TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, data TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), repository_id TEXT NOT NULL REFERENCES repositories(id), UNIQUE(run_id,repository_id));
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, data TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES(1);
CREATE TABLE IF NOT EXISTS worktrees(id TEXT PRIMARY KEY, data TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), repository_id TEXT NOT NULL REFERENCES repositories(id), path TEXT NOT NULL UNIQUE, request_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS run_worktrees(run_id TEXT NOT NULL REFERENCES runs(id), worktree_id TEXT NOT NULL REFERENCES worktrees(id), PRIMARY KEY(run_id,worktree_id));
CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,data TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),issue_id TEXT NOT NULL REFERENCES issues(id),fingerprint TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS webhook_receipts(integration_id TEXT NOT NULL REFERENCES integrations(id),digest TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(integration_id,digest));
INSERT OR IGNORE INTO schema_migrations VALUES(2);
`

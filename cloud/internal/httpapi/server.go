package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/app"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/repos"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

type Actor struct {
	Role        string
	WorkspaceID string
	RunID       string
	SessionID   string
	Generation  string
}
type actorKey struct{}
type Server struct {
	App    *app.App
	Assets fs.FS
	mux    *http.ServeMux
}

func New(a *app.App, assets fs.FS) *Server {
	s := &Server{App: a, Assets: assets, mux: http.NewServeMux()}
	s.routes()
	return s
}
func constant(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func (s *Server) actor(r *http.Request) (Actor, error) {
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if bearer != "" {
		if constant(bearer, s.App.AdminToken) {
			return Actor{Role: "human"}, nil
		}
		id, gen := r.Header.Get("X-Autopilot-Session"), r.Header.Get("X-Autopilot-Generation")
		if id == "" || gen == "" {
			return Actor{}, fmt.Errorf("invalid session credentials")
		}
		token, e := s.App.Secret("session-" + id + "-" + gen)
		if e != nil || !constant(token, bearer) {
			return Actor{}, fmt.Errorf("invalid session credentials")
		}
		session, e := storage.Get[domain.Session](r.Context(), s.App.Store.DB, "sessions", id)
		if e != nil || session.Generation != gen || !slices.Contains([]string{"starting", "working", "idle", "unknown", "needs_input"}, session.State) {
			return Actor{}, fmt.Errorf("expired session credentials")
		}
		return Actor{Role: session.Role, WorkspaceID: session.WorkspaceID, RunID: session.RunID, SessionID: id, Generation: gen}, nil
	}
	if r.Method != "GET" && r.Method != "HEAD" && !constant(r.Header.Get("X-CSRF-Token"), s.App.CSRF) {
		return Actor{}, fmt.Errorf("missing or expired request token")
	}
	return Actor{Role: "human"}, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if !slices.Contains(s.App.Config.AllowedHosts, r.Host) {
		http.Error(w, "forbidden host", 403)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || !slices.Contains(s.App.Config.AllowedHosts, u.Host) {
			http.Error(w, "forbidden origin", 403)
			return
		}
	}
	if r.URL.Path == "/healthz" {
		write(w, map[string]string{"status": "ok"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/hooks/") {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if e != nil {
			http.Error(w, "payload too large", 413)
			return
		}
		if e = s.App.ReceiveWebhook(r.Context(), strings.TrimPrefix(r.URL.Path, "/hooks/"), r.Header.Get("Linear-Signature"), r.Header.Get("X-Hub-Signature"), body); e != nil {
			http.Error(w, e.Error(), 403)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
		actor, e := s.actor(r)
		if e != nil {
			http.Error(w, e.Error(), 403)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), actorKey{}, actor))
		s.mux.ServeHTTP(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "method not allowed", 405)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if !fs.ValidPath(path) {
		http.NotFound(w, r)
		return
	}
	b, e := fs.ReadFile(s.Assets, path)
	if e != nil {
		b, e = fs.ReadFile(s.Assets, "index.html")
		path = "index.html"
	}
	if e != nil {
		http.Error(w, "Build the web app first: cd web && bun run build", 503)
		return
	}
	switch {
	case strings.HasSuffix(path, ".js"):
		w.Header().Set("Content-Type", "application/javascript")
	case strings.HasSuffix(path, ".css"):
		w.Header().Set("Content-Type", "text/css")
	case strings.HasSuffix(path, ".html"):
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	w.Write(b)
}
func actor(r *http.Request) Actor { return r.Context().Value(actorKey{}).(Actor) }
func human(r *http.Request) error {
	if actor(r).Role != "human" {
		return fmt.Errorf("this action requires a human operator")
	}
	return nil
}
func scope(r *http.Request, workspaceID string) error {
	a := actor(r)
	if a.Role != "human" && a.WorkspaceID != workspaceID {
		return fmt.Errorf("outside session workspace")
	}
	return nil
}
func decode[T any](r *http.Request) (T, error) {
	var v T
	d := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	d.DisallowUnknownFields()
	e := d.Decode(&v)
	if e == nil {
		var extra any
		if d.Decode(&extra) != io.EOF {
			e = fmt.Errorf("expected one JSON value")
		}
	}
	return v, e
}
func write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func endpoint(fn func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, e := fn(r)
		if e != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": e.Error()})
			return
		}
		write(w, v)
	}
}
func requireHuman(fn func(*http.Request) (any, error)) http.HandlerFunc {
	return endpoint(func(r *http.Request) (any, error) {
		if e := human(r); e != nil {
			return nil, e
		}
		return fn(r)
	})
}

func (s *Server) routes() {
	a := s.App
	m := s.mux
	m.HandleFunc("GET /api/v1/worktrees/{id}/review", requireHuman(func(r *http.Request) (any, error) { return a.ReviewWorktree(r.Context(), r.PathValue("id")) }))
	m.HandleFunc("GET /api/v1/snapshot", endpoint(func(r *http.Request) (any, error) {
		snap, e := a.Snapshot(r.Context())
		if e != nil {
			return nil, e
		}
		who := actor(r)
		if who.Role == "human" {
			return snap, nil
		}
		snap.CSRF = ""
		snap.Integrations = nil
		snap.Workspaces = filter(snap.Workspaces, func(x domain.Workspace) bool { return x.ID == who.WorkspaceID })
		snap.Repositories = filter(snap.Repositories, func(x domain.Repository) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Queue = filter(snap.Queue, func(x domain.QueueEntry) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Worktrees = filter(snap.Worktrees, func(x domain.Worktree) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Projects = filter(snap.Projects, func(x domain.Project) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Issues = filter(snap.Issues, func(x domain.Issue) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Plans = filter(snap.Plans, func(x domain.Plan) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Executions = filter(snap.Executions, func(x domain.Execution) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Runs = filter(snap.Runs, func(x domain.Run) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Sessions = filter(snap.Sessions, func(x domain.Session) bool { return x.WorkspaceID == who.WorkspaceID })
		snap.Comments = nil
		snap.Actions = nil
		snap.Changes = nil
		return snap, nil
	}))
	m.HandleFunc("POST /api/v1/integrations/{id}/webhook", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Enabled bool   `json:"enabled"`
			Secret  string `json:"secret"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.ConfigureWebhook(r.Context(), r.PathValue("id"), v.Enabled, v.Secret)
	}))
	m.HandleFunc("POST /api/v1/integrations/{id}/verify", requireHuman(func(r *http.Request) (any, error) { return a.VerifyIntegration(r.Context(), r.PathValue("id")) }))
	m.HandleFunc("GET /api/v1/integrations/{id}/discover-tickets", requireHuman(func(r *http.Request) (any, error) { return a.DiscoverTickets(r.Context(), r.PathValue("id")) }))
	m.HandleFunc("POST /api/v1/queue/{id}/dismiss", requireHuman(func(r *http.Request) (any, error) {
		return map[string]bool{"ok": true}, a.QueueDecision(r.Context(), r.PathValue("id"))
	}))
	m.HandleFunc("GET /api/v1/settings", requireHuman(func(r *http.Request) (any, error) { return a.Settings(), nil }))
	m.HandleFunc("POST /api/v1/settings/profiles", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[domain.HarnessProfile](r)
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, a.SaveProfile(r.Context(), v)
	}))
	m.HandleFunc("GET /api/v1/plugins", endpoint(func(r *http.Request) (any, error) { return a.Plugins.Manifests(r.Context()), nil }))
	m.HandleFunc("POST /api/v1/repositories/{id}/scan", requireHuman(func(r *http.Request) (any, error) {
		return map[string]bool{"ok": true}, a.DiscoverWorktrees(r.Context(), r.PathValue("id"))
	}))
	m.HandleFunc("GET /api/v1/repositories/{id}/branches", requireHuman(func(r *http.Request) (any, error) {
		return a.RepositoryInfo(r.Context(), r.PathValue("id"), "branches")
	}))
	m.HandleFunc("POST /api/v1/repositories/{id}/fetch", requireHuman(func(r *http.Request) (any, error) { return a.RepositoryInfo(r.Context(), r.PathValue("id"), "fetch") }))
	m.HandleFunc("POST /api/v1/repositories/{id}/worktrees", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[app.NewWorktree](r)
		if e != nil {
			return nil, e
		}
		return a.CreateWorktree(r.Context(), r.PathValue("id"), r.Header.Get("Idempotency-Key"), v)
	}))
	m.HandleFunc("POST /api/v1/worktrees/{id}/actions/{action}", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Revision int `json:"revision"`
		}](r)
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, a.WorktreeAction(r.Context(), r.PathValue("id"), r.PathValue("action"), v.Revision)
	}))
	m.HandleFunc("POST /api/v1/worktrees/{id}/sessions", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Kind    string `json:"kind"`
			Harness string `json:"harness"`
			Prompt  string `json:"prompt"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.StartWorktreeSession(r.Context(), r.PathValue("id"), v.Kind, v.Harness, v.Prompt)
	}))
	m.HandleFunc("GET /api/v1/worktrees/{id}/changes", requireHuman(func(r *http.Request) (any, error) { return a.WorktreeChanges(r.Context(), r.PathValue("id")) }))
	m.HandleFunc("POST /api/v1/worktrees/{id}/issues", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			IssueID string `json:"issueId"`
		}](r)
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, a.LinkWorktreeIssue(r.Context(), r.PathValue("id"), v.IssueID)
	}))
	m.HandleFunc("GET /api/v1/events", s.events)
	m.HandleFunc("POST /api/v1/workspaces", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[domain.Workspace](r)
		if e != nil {
			return nil, e
		}
		return a.CreateWorkspace(r.Context(), v)
	}))
	m.HandleFunc("POST /api/v1/workspaces/scan", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Root string `json:"root"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.ScanWorkspace(r.Context(), v.Root)
	}))
	m.HandleFunc("POST /api/v1/workspaces/import", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			domain.Workspace
			RepositoryPaths []string `json:"repositoryPaths"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.ImportWorkspace(r.Context(), v.Workspace, v.RepositoryPaths)
	}))
	m.HandleFunc("DELETE /api/v1/workspaces/{id}", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Revision int `json:"revision"`
		}](r)
		if e != nil {
			return nil, e
		}
		return map[string]bool{"removed": true}, a.RemoveWorkspace(r.Context(), r.PathValue("id"), v.Revision)
	}))
	m.HandleFunc("PATCH /api/v1/workspaces/{id}", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[domain.Workspace](r)
		if e != nil {
			return nil, e
		}
		return a.SaveWorkspace(r.Context(), r.PathValue("id"), v)
	}))
	m.HandleFunc("GET /api/v1/workspaces/{id}/discover", endpoint(func(r *http.Request) (any, error) {
		if e := human(r); e != nil {
			return nil, e
		}
		w, e := storage.Get[domain.Workspace](r.Context(), a.Store.DB, "workspaces", r.PathValue("id"))
		if e != nil {
			return nil, e
		}
		return repos.Discover(r.Context(), w.Root)
	}))
	m.HandleFunc("POST /api/v1/repositories", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			domain.Repository
			Clone bool `json:"clone"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.AddRepository(r.Context(), v.Repository, v.Clone)
	}))
	m.HandleFunc("POST /api/v1/projects", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[domain.Project](r)
		if e != nil {
			return nil, e
		}
		return a.CreateProject(r.Context(), v)
	}))
	m.HandleFunc("PATCH /api/v1/repositories/{id}/integration", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Revision      int    `json:"revision"`
			IntegrationID string `json:"integrationId"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.ConnectRepository(r.Context(), r.PathValue("id"), v.Revision, v.IntegrationID)
	}))
	m.HandleFunc("POST /api/v1/issues", endpoint(func(r *http.Request) (any, error) {
		v, e := decode[domain.Issue](r)
		if e != nil {
			return nil, e
		}
		if actor(r).Role == "worker" {
			return nil, fmt.Errorf("workers cannot create tasks")
		}
		if e = scope(r, v.WorkspaceID); e != nil {
			return nil, e
		}
		return a.CreateIssue(r.Context(), v)
	}))
	m.HandleFunc("PATCH /api/v1/issues/{id}", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[domain.Issue](r)
		if e != nil {
			return nil, e
		}
		return a.UpdateIssue(r.Context(), r.PathValue("id"), v)
	}))
	m.HandleFunc("POST /api/v1/issues/{id}/comments", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Body string `json:"body"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.Comment(r.Context(), r.PathValue("id"), v.Body)
	}))
	m.HandleFunc("POST /api/v1/issues/{id}/tracker", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Kind string `json:"kind"`
			Body string `json:"body"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.TrackerAction(r.Context(), r.PathValue("id"), v.Kind, v.Body, r.Header.Get("Idempotency-Key"))
	}))
	m.HandleFunc("POST /api/v1/plans", endpoint(func(r *http.Request) (any, error) {
		v, e := decode[domain.Plan](r)
		if e != nil {
			return nil, e
		}
		if actor(r).Role == "worker" {
			return nil, fmt.Errorf("workers cannot propose or dispatch workers")
		}
		if e = scope(r, v.WorkspaceID); e != nil {
			return nil, e
		}
		return a.SavePlan(r.Context(), v)
	}))
	m.HandleFunc("POST /api/v1/plans/{id}/approve", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Revision int `json:"revision"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.Approve(r.Context(), r.PathValue("id"), v.Revision, r.Header.Get("Idempotency-Key"))
	}))
	m.HandleFunc("POST /api/v1/workspaces/{id}/orchestrator", requireHuman(func(r *http.Request) (any, error) { return a.Orchestrator(r.Context(), r.PathValue("id")) }))
	m.HandleFunc("POST /api/v1/runs/{id}/{action}", requireHuman(func(r *http.Request) (any, error) {
		return map[string]bool{"ok": true}, a.RunAction(r.Context(), r.PathValue("id"), r.PathValue("action"))
	}))
	m.HandleFunc("POST /api/v1/runs/{id}/followup", endpoint(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Body string `json:"body"`
		}](r)
		if e != nil {
			return nil, e
		}
		who := actor(r)
		if who.Role == "worker" {
			return nil, fmt.Errorf("workers cannot direct other workers")
		}
		run, e := storage.Get[domain.Run](r.Context(), a.Store.DB, "runs", r.PathValue("id"))
		if e != nil {
			return nil, e
		}
		if e = scope(r, run.WorkspaceID); e != nil {
			return nil, e
		}
		return a.Followup(r.Context(), run.ID, v.Body, r.Header.Get("Idempotency-Key"))
	}))
	m.HandleFunc("POST /api/v1/sessions/{id}/{action}", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			Body           string `json:"body"`
			ConversationID string `json:"conversationId"`
		}](r)
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, a.SessionAction(r.Context(), r.PathValue("id"), r.PathValue("action"), v.Body, v.ConversationID)
	}))
	m.HandleFunc("GET /api/v1/sessions/{id}/preview", endpoint(func(r *http.Request) (any, error) {
		if e := human(r); e != nil {
			return nil, e
		}
		return a.SessionPreview(r.Context(), r.PathValue("id"))
	}))
	m.HandleFunc("POST /api/v1/signal", endpoint(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			State          string `json:"state"`
			ConversationID string `json:"conversationId"`
			Message        string `json:"message"`
			HookEvent      string `json:"hookEvent"`
			Notification   string `json:"notification"`
		}](r)
		if e != nil {
			return nil, e
		}
		who := actor(r)
		if who.SessionID == "" {
			return nil, fmt.Errorf("agent session credentials required")
		}
		if v.HookEvent != "" {
			return map[string]bool{"ok": true}, a.NativeSignal(r.Context(), who.SessionID, who.Generation, v.HookEvent, v.ConversationID, v.Notification)
		}
		return map[string]bool{"ok": true}, a.Signal(r.Context(), who.SessionID, who.Generation, v.State, v.ConversationID, v.Message)
	}))
	m.HandleFunc("POST /api/v1/integrations", requireHuman(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			domain.Integration
			Token string `json:"token"`
		}](r)
		if e != nil {
			return nil, e
		}
		return a.SaveIntegration(r.Context(), v.Integration, v.Token)
	}))
	m.HandleFunc("POST /api/v1/integrations/{id}/sync", requireHuman(func(r *http.Request) (any, error) {
		return map[string]bool{"ok": true}, a.Sync(r.Context(), r.PathValue("id"))
	}))
	m.HandleFunc("GET /api/v1/integrations/{id}/statuses", endpoint(func(r *http.Request) (any, error) {
		if e := human(r); e != nil {
			return nil, e
		}
		return a.Statuses(r.Context(), r.PathValue("id"))
	}))
	m.HandleFunc("POST /api/v1/actions/{id}/{decision}", requireHuman(func(r *http.Request) (any, error) {
		return map[string]bool{"ok": true}, a.ActionDecision(r.Context(), r.PathValue("id"), r.PathValue("decision"))
	}))
	m.HandleFunc("POST /api/v1/changes", endpoint(func(r *http.Request) (any, error) {
		v, e := decode[struct {
			RunID        string `json:"runId"`
			RepositoryID string `json:"repositoryId"`
			Title        string `json:"title"`
			Body         string `json:"body"`
		}](r)
		if e != nil {
			return nil, e
		}
		who := actor(r)
		if who.Role != "human" && who.RunID != v.RunID {
			return nil, fmt.Errorf("change request is outside this worker run")
		}
		return a.CreateChange(r.Context(), v.RunID, v.RepositoryID, v.Title, v.Body)
	}))
	m.HandleFunc("GET /api/v1/sessions/{id}/terminal", s.terminal)
}
func filter[T any](xs []T, keep func(T) bool) []T {
	out := []T{}
	for _, x := range xs {
		if keep(x) {
			out = append(out, x)
		}
	}
	return out
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		after, _ = strconv.ParseInt(v, 10, 64)
	}
	if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		events, e := s.App.Store.Events(r.Context(), after)
		if e != nil {
			http.Error(w, e.Error(), 500)
			return
		}
		write(w, s.scopedEvents(r, events))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, cancel := s.App.Store.Subscribe()
	defer cancel()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		events, e := s.App.Store.Events(r.Context(), after)
		if e != nil {
			return
		}
		if _, e := s.actor(r); e != nil {
			return
		}
		if len(events) > 0 {
			after = events[len(events)-1].Sequence
		}
		for _, event := range s.scopedEvents(r, events) {
			b, _ := json.Marshal(event)
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", event.Sequence, b)
		}
		fmt.Fprint(w, ": connected\n\n")
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-ch:
		case <-ticker.C:
		}
	}
}

func (s *Server) scopedEvents(r *http.Request, events []domain.Event) []domain.Event {
	who := actor(r)
	if who.Role == "human" {
		return events
	}
	ids := map[string]bool{who.SessionID: true}
	if who.RunID != "" {
		ids[who.RunID] = true
	}
	if who.Role == "orchestrator" {
		snap, err := s.App.Snapshot(r.Context())
		if err != nil {
			return nil
		}
		ids[who.WorkspaceID] = true
		for _, v := range snap.Issues {
			if v.WorkspaceID == who.WorkspaceID {
				ids[v.ID] = true
			}
		}
		for _, v := range snap.Plans {
			if v.WorkspaceID == who.WorkspaceID {
				ids[v.ID] = true
			}
		}
		for _, v := range snap.Executions {
			if v.WorkspaceID == who.WorkspaceID {
				ids[v.ID] = true
			}
		}
		for _, v := range snap.Runs {
			if v.WorkspaceID == who.WorkspaceID {
				ids[v.ID] = true
			}
		}
		for _, v := range snap.Sessions {
			if v.WorkspaceID == who.WorkspaceID {
				ids[v.ID] = true
			}
		}
	}
	return filter(events, func(e domain.Event) bool { return ids[e.EntityID] })
}

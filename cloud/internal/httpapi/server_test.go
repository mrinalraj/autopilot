package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mrinalraj/autopilot/cloud/internal/app"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func TestHostCSRFAndWorkerAuthority(t *testing.T) {
	cfg, err := app.LoadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg.AllowedHosts = []string{"autopilot.test"}
	a, err := app.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.Close()
	srv := New(a, fstest.MapFS{"index.html": {Data: []byte("ok")}})
	call := func(method, path, body, host, csrf, token, id, gen string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://autopilot.test"+path, strings.NewReader(body))
		r.Host = host
		r.Header.Set("X-CSRF-Token", csrf)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("X-Autopilot-Session", id)
			r.Header.Set("X-Autopilot-Generation", gen)
		}
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w
	}
	if r := call("GET", "/api/v1/snapshot", "", "attacker.test", "", "", "", ""); r.Code != 403 {
		t.Fatal("untrusted host accepted")
	}
	if r := call("POST", "/api/v1/workspaces", `{"name":"oops"}`, "autopilot.test", "", "", "", ""); r.Code != 403 {
		t.Fatal("missing csrf accepted")
	}
	r := call("POST", "/api/v1/workspaces", `{"name":"Test"}`, "autopilot.test", a.CSRF, "", "", "")
	if r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	var workspace domain.Workspace
	if err = json.Unmarshal(r.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	other, err := a.CreateWorkspace(context.Background(), domain.Workspace{Name: "Private workspace"})
	if err != nil {
		t.Fatal(err)
	}
	s := domain.Session{Meta: domain.NewMeta(), WorkspaceID: workspace.ID, Role: "worker", Handle: "fake", Generation: "current", State: "idle"}
	if err = storage.Save(context.Background(), a.Store.DB, "sessions", s.ID, s, "workspace_id", workspace.ID, "handle", s.Handle); err != nil {
		t.Fatal(err)
	}
	a.SetSecret("session-"+s.ID+"-current", "worker-token")
	r = call("GET", "/api/v1/snapshot", "", "autopilot.test", "", "worker-token", s.ID, "current")
	if r.Code != 200 || strings.Contains(r.Body.String(), other.ID) || strings.Contains(r.Body.String(), a.CSRF) {
		t.Fatal("worker snapshot leaked scope or csrf")
	}
	r = call("POST", "/api/v1/workspaces", `{"name":"Forbidden"}`, "autopilot.test", "", "worker-token", s.ID, "current")
	if r.Code < 400 {
		t.Fatal("worker performed human action")
	}
	for _, route := range []struct{ method, path, body string }{
		{"POST", "/api/v1/workspaces/scan", `{"root":"/tmp"}`},
		{"POST", "/api/v1/workspaces/import", `{"name":"Forbidden","root":"/tmp"}`},
		{"DELETE", "/api/v1/workspaces/" + workspace.ID, `{"revision":1}`},
	} {
		if r := call(route.method, route.path, route.body, "autopilot.test", "", "worker-token", s.ID, "current"); r.Code != 400 || !strings.Contains(r.Body.String(), "requires a human operator") {
			t.Fatalf("worker allowed workspace management: %s %s: %d", route.method, route.path, r.Code)
		}
	}
	r = call("POST", "/api/v1/plans/anything/approve", `{"revision":1}`, "autopilot.test", "", "worker-token", s.ID, "current")
	if r.Code < 400 {
		t.Fatal("worker approved plan")
	}
	a.SetSecret("session-"+s.ID+"-old", "old-token")
	r = call("POST", "/api/v1/signal", `{"state":"idle"}`, "autopilot.test", "", "old-token", s.ID, "old")
	if r.Code != 403 {
		t.Fatal("old launch generation accepted")
	}
	r = call("GET", "/api/v1/events", "", "autopilot.test", "", "worker-token", s.ID, "current")
	if r.Code != 200 || strings.Contains(r.Body.String(), "Private workspace") {
		t.Fatal("event scope incorrect")
	}
	origin := httptest.NewRequest(http.MethodGet, "http://autopilot.test/api/v1/snapshot", nil)
	origin.Header.Set("Origin", "https://evil.test")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, origin)
	if rec.Code != 403 {
		t.Fatal("foreign origin accepted")
	}
}

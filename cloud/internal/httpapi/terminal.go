package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/runner"
	"github.com/mrinalraj/autopilot/cloud/internal/storage"
)

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	if human(r) != nil || !constant(r.URL.Query().Get("token"), s.App.CSRF) || r.Header.Get("Origin") == "" {
		http.Error(w, "terminal request denied", 403)
		return
	}
	session, e := storage.Get[domain.Session](r.Context(), s.App.Store.DB, "sessions", r.PathValue("id"))
	if e != nil {
		http.Error(w, "session not found", 404)
		return
	}
	tmux, ok := s.App.Launcher.(*runner.Tmux)
	if !ok {
		http.Error(w, "terminal unavailable", 503)
		return
	}
	inspection, e := tmux.Inspect(r.Context(), session.Handle)
	if e != nil || !inspection.Exists || inspection.Dead {
		http.Error(w, "session is not live", 409)
		return
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.App.Config.AllowedHosts})
	if e != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	args := []string{"attach-session", "-t", session.Handle}
	cmd := tmux.Command(ctx, args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, e := pty.StartWithSize(cmd, &pty.Winsize{Rows: 36, Cols: 120})
	if e != nil {
		conn.Close(websocket.StatusInternalError, "Could not attach terminal")
		return
	}
	defer f.Close()
	defer cmd.Wait()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		buf := make([]byte, 16384)
		for {
			n, e := f.Read(buf)
			if n > 0 {
				writeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(writeCtx, websocket.MessageBinary, buf[:n])
				stop()
				if err != nil {
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	defer func() { cancel(); f.Close(); wg.Wait() }()
	for {
		kind, b, e := conn.Read(ctx)
		if e != nil {
			return
		}
		if kind == websocket.MessageBinary {
			if e = s.App.Signal(ctx, session.ID, session.Generation, "working", "", "Terminal input"); e != nil {
				return
			}
			_, e = f.Write(b)
			if e != nil {
				return
			}
		} else {
			var size struct {
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if json.Unmarshal(b, &size) == nil && size.Cols >= 20 && size.Cols <= 500 && size.Rows >= 5 && size.Rows <= 200 {
				pty.Setsize(f, &pty.Winsize{Cols: size.Cols, Rows: size.Rows})
			}
		}
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/app"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/httpapi"
	"github.com/mrinalraj/autopilot/cloud/internal/runner"
	"github.com/mrinalraj/autopilot/cloud/web"
)

func main() {
	if e := run(); e != nil {
		slog.Error("autopilot", "error", e)
		os.Exit(1)
	}
}
func loadConfig() (app.Config, error) {
	return app.LoadConfig(os.Getenv("AUTOPILOT_DATA_DIR"))
}
func run() error {
	args := os.Args[1:]
	command := "serve"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "version":
		fmt.Println("autopilot-cloud 0.1.0")
		return nil
	case "agent-exec":
		if len(args) != 1 {
			return fmt.Errorf("agent-exec requires a launch file")
		}
		return runner.ExecAgent(args[0])
	case "supervise":
		return supervise()
	case "serve":
		return serve()
	case "tools":
		return installTool(args)
	case "backup":
		return backup(args)
	case "help", "--help", "-h":
		fmt.Println("autopilot serve | supervise | version | snapshot | events | plan --file plan.json | report --state STATE --message TEXT | followup --run ID --message TEXT | changes create --run ID --repository ID --title TITLE --body TEXT\nConfiguration: AUTOPILOT_DATA_DIR, AUTOPILOT_LISTEN, AUTOPILOT_ALLOWED_HOSTS")
		return nil
	default:
		return client(command, args)
	}
}
func serve() error {
	cfg, e := loadConfig()
	if e != nil {
		return e
	}
	listener, e := net.Listen("tcp", cfg.Address)
	if e != nil {
		return e
	}
	defer listener.Close()
	if e = os.MkdirAll(cfg.DataDir, 0700); e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(cfg.DataDir, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return fmt.Errorf("another server owns this data directory")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	os.Setenv("PATH", filepath.Join(cfg.DataDir, "tools", "bin")+":"+os.Getenv("PATH"))
	a, e := app.New(cfg)
	if e != nil {
		return e
	}
	defer a.Store.Close()
	tmux, e := runner.New(cfg.DataDir)
	if e != nil {
		return e
	}
	a.Launcher = tmux
	// Keep the agent-facing CLI available even when the binary was started by absolute path.
	exe, e := os.Executable()
	if e == nil {
		link := filepath.Join(cfg.DataDir, "tools", "bin", "autopilot")
		if old, e := os.Readlink(link); e == nil && old != exe {
			os.Remove(link)
		}
		if _, e := os.Lstat(link); os.IsNotExist(e) {
			os.Symlink(exe, link)
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &http.Server{Addr: cfg.Address, Handler: httpapi.New(a, web.Assets()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go a.Loop(ctx)
	go func() {
		<-ctx.Done()
		stop, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		server.Shutdown(stop)
	}()
	slog.Info("Autopilot ready", "address", cfg.Address, "data", cfg.DataDir)
	e = server.Serve(listener)
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
func supervise() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	failures := []time.Time{}
	for {
		cmd := exec.Command(exe, "serve")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = os.Environ()
		if e = cmd.Start(); e != nil {
			return e
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-ctx.Done():
			cmd.Process.Signal(syscall.SIGTERM)
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				cmd.Process.Kill()
				<-done
			}
			return nil
		case e = <-done:
			if e == nil {
				return nil
			}
		}
		now := time.Now()
		recent := []time.Time{}
		for _, t := range failures {
			if now.Sub(t) < time.Minute {
				recent = append(recent, t)
			}
		}
		failures = append(recent, now)
		if len(failures) >= 3 {
			slog.Error("server crash circuit open; tmux sessions remain available until container restart")
			<-ctx.Done()
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}
func client(command string, args []string) error {
	base := os.Getenv("AUTOPILOT_URL")
	if base == "" {
		base = "http://127.0.0.1:4780"
	}
	token := os.Getenv("AUTOPILOT_TOKEN")
	if token == "" {
		cfg, e := loadConfig()
		if e != nil {
			return e
		}
		b, e := os.ReadFile(filepath.Join(cfg.DataDir, "secrets", "admin"))
		if e != nil {
			return fmt.Errorf("AUTOPILOT_TOKEN is required outside an installation")
		}
		token = string(b)
	}
	path, method := "/api/v1/"+command, "GET"
	var body any
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	switch command {
	case "snapshot", "events":
	case "hook":
		var event struct {
			Name         string `json:"hook_event_name"`
			Conversation string `json:"session_id"`
			Notification string `json:"notification_type"`
		}
		if e := json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&event); e != nil {
			return e
		}
		body = map[string]string{"hookEvent": event.Name, "conversationId": event.Conversation, "notification": event.Notification}
		path = "/api/v1/signal"
		method = "POST"
	case "plan":
		file := flags.String("file", "", "plan JSON file")
		if e := flags.Parse(args); e != nil {
			return e
		}
		b, e := os.ReadFile(*file)
		if e != nil {
			return e
		}
		if e = json.Unmarshal(b, &body); e != nil {
			return e
		}
		path = "/api/v1/plans"
		method = "POST"
	case "report", "signal":
		state := flags.String("state", "unknown", "working, idle, needs_input, unknown")
		message := flags.String("message", "", "progress message")
		conversation := flags.String("conversation", "", "native conversation id")
		if e := flags.Parse(args); e != nil {
			return e
		}
		body = map[string]string{"state": *state, "message": *message, "conversationId": *conversation}
		path = "/api/v1/signal"
		method = "POST"
	case "followup":
		run := flags.String("run", "", "worker run ID")
		message := flags.String("message", "", "follow-up prompt")
		if e := flags.Parse(args); e != nil {
			return e
		}
		path = "/api/v1/runs/" + *run + "/followup"
		body = map[string]string{"body": *message}
		method = "POST"
	case "changes":
		if len(args) == 0 || args[0] != "create" {
			return fmt.Errorf("use changes create")
		}
		run := flags.String("run", "", "run ID")
		repo := flags.String("repository", "", "repository ID")
		title := flags.String("title", "", "title")
		text := flags.String("body", "", "description")
		if e := flags.Parse(args[1:]); e != nil {
			return e
		}
		body = map[string]string{"runId": *run, "repositoryId": *repo, "title": *title, "body": *text}
		method = "POST"
	default:
		return fmt.Errorf("unknown command %s; run autopilot help", command)
	}
	var reader io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		reader = bytes.NewReader(b)
	}
	req, e := http.NewRequest(method, strings.TrimRight(base, "/")+path, reader)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", domain.ID())
	req.Header.Set("X-Autopilot-Session", os.Getenv("AUTOPILOT_SESSION_ID"))
	req.Header.Set("X-Autopilot-Generation", os.Getenv("AUTOPILOT_GENERATION"))
	res, e := (&http.Client{Timeout: 2 * time.Minute}).Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if e != nil {
		return e
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s", b)
	}
	if command != "hook" {
		fmt.Println(string(b))
	}
	return nil
}

package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/mrinalraj/autopilot/cloud/internal/agents"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
)

type Tmux struct {
	Socket  string
	Config  string
	DataDir string
}

func New(dataDir string) (*Tmux, error) {
	hash := sha256.Sum256([]byte(dataDir))
	t := &Tmux{Socket: filepath.Join(os.TempDir(), "autopilot-"+hex.EncodeToString(hash[:8])+".sock"), Config: filepath.Join(dataDir, "tmux.conf"), DataDir: dataDir}
	err := os.WriteFile(t.Config, []byte("set-window-option -g remain-on-exit on\nset -g history-limit 5000\nset -g default-shell /bin/sh\nset -g status off\nset -g exit-empty off\n"), 0600)
	return t, err
}
func (t *Tmux) Command(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "tmux", append([]string{"-S", t.Socket, "-f", t.Config}, args...)...)
}
func (t *Tmux) call(ctx context.Context, args ...string) (string, error) {
	b, err := t.Command(ctx, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("tmux %s: %s", args[0], strings.TrimSpace(string(b)))
	}
	return strings.TrimSpace(string(b)), nil
}
func Quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

type Command struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
	Env        []string `json:"env"`
	Directory  string   `json:"directory"`
}

func (t *Tmux) Start(ctx context.Context, r plugins.LaunchRequest) error {
	s := r.Session
	if inspection, err := t.Inspect(ctx, s.Handle); err == nil && inspection.Exists {
		if !inspection.Dead {
			return nil
		}
		return fmt.Errorf("session already exists and has exited")
	}
	dir := filepath.Join(t.DataDir, "sessions", s.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	prepared, err := (agents.CLI{}).Prepare(ctx, s, dir, r.Executable)
	if err != nil {
		return err
	}
	if s.Harness.ID == "opencode" {
		config := map[string]any{}
		env := []string{}
		for _, v := range r.Environment {
			if strings.HasPrefix(v, "OPENCODE_CONFIG_CONTENT=") {
				if e := json.Unmarshal([]byte(strings.TrimPrefix(v, "OPENCODE_CONFIG_CONTENT=")), &config); e != nil {
					return fmt.Errorf("invalid OpenCode inline configuration")
				}
			} else {
				env = append(env, v)
			}
		}
		config["permission"] = "allow"
		content, _ := json.Marshal(config)
		r.Environment = append(env, "OPENCODE_CONFIG_CONTENT="+string(content))
	}
	file := filepath.Join(dir, "launch.json")
	b, err := json.Marshal(Command{Executable: prepared.Executable, Args: prepared.Args, Env: r.Environment, Directory: s.Directory})
	if err != nil {
		return err
	}
	if err = os.WriteFile(file, b, 0600); err != nil {
		return err
	}
	_, err = t.call(ctx, "new-session", "-d", "-s", s.Handle, "-x", "120", "-y", "36", "-c", s.Directory, "exec "+Quote(r.Executable)+" agent-exec "+Quote(file))
	return err
}
func (t *Tmux) Inspect(ctx context.Context, handle string) (plugins.Inspection, error) {
	info, err := t.call(ctx, "list-panes", "-t", handle, "-F", "#{pane_dead}|#{pane_dead_status}|#{session_attached}")
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "can't find") || strings.Contains(msg, "no server") || strings.Contains(msg, "error connecting") {
			return plugins.Inspection{}, nil
		}
		return plugins.Inspection{}, err
	}
	parts := strings.Split(strings.Split(info, "\n")[0], "|")
	i := plugins.Inspection{Exists: true, Dead: parts[0] == "1"}
	if len(parts) > 1 {
		i.ExitCode, _ = strconv.Atoi(parts[1])
	}
	if len(parts) > 2 {
		i.Attached, _ = strconv.Atoi(parts[2])
	}
	i.Preview, _ = t.call(ctx, "capture-pane", "-p", "-J", "-S", "-15", "-t", handle)
	return i, nil
}
func (t *Tmux) Send(ctx context.Context, handle, text string) error {
	// A named buffer avoids concurrent sends sharing tmux's default paste buffer.
	name := "ap-" + domain.ID()
	cmd := t.Command(ctx, "load-buffer", "-b", name, "-")
	cmd.Stdin = strings.NewReader(text)
	if b, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("load prompt: %s", b)
	}
	defer t.call(context.Background(), "delete-buffer", "-b", name)
	if _, err := t.call(ctx, "paste-buffer", "-p", "-b", name, "-t", handle); err != nil {
		return err
	}
	_, err := t.call(ctx, "send-keys", "-t", handle, "Enter")
	return err
}
func (t *Tmux) Interrupt(ctx context.Context, handle string) error {
	_, err := t.call(ctx, "send-keys", "-t", handle, "C-c")
	return err
}
func (t *Tmux) Stop(ctx context.Context, handle string) error {
	i, err := t.Inspect(ctx, handle)
	if err != nil || !i.Exists {
		return err
	}
	_, err = t.call(ctx, "kill-session", "-t", handle)
	return err
}

// ExecAgent is a re-exec entrypoint: tmux receives only a path, never a shell-expanded prompt.
func ExecAgent(file string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var c Command
	if err = json.Unmarshal(b, &c); err != nil {
		return err
	}
	if err = os.Chdir(c.Directory); err != nil {
		return err
	}
	return syscall.Exec(c.Executable, append([]string{c.Executable}, c.Args...), c.Env)
}

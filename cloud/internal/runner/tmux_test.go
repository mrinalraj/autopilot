package runner

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "agent-exec":
			if err := ExecAgent(os.Args[2]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "fake-agent":
			fmt.Println("BOOT", strings.Join(os.Args[2:], " "))
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
				fmt.Println("RECEIVED", scanner.Text())
			}
			return
		}
	}
	os.Exit(m.Run())
}
func TestRealTmuxLiteralPromptAndSurvival(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	tm, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tm.call(ctx, "kill-server"); os.Remove(tm.Socket) })
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "must-not-exist")
	prompt := "literal $(touch " + marker + ") `echo boom` 'quoted'"
	s := domain.Session{Meta: domain.NewMeta(), Handle: "test-worker", Directory: dir, Prompt: prompt, Harness: domain.HarnessProfile{ID: "fake", Command: exe, Args: []string{"fake-agent"}, PromptMode: "arg"}}
	request := plugins.LaunchRequest{Session: s, Environment: os.Environ(), Executable: exe}
	if err = tm.Start(ctx, request); err != nil {
		t.Fatal(err)
	}
	wait := func(text string) {
		t.Helper()
		until := time.Now().Add(5 * time.Second)
		for time.Now().Before(until) {
			i, e := tm.Inspect(ctx, s.Handle)
			if e == nil && strings.Contains(i.Preview, text) {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		i, _ := tm.Inspect(ctx, s.Handle)
		t.Fatalf("missing %q in %q", text, i.Preview)
	}
	wait("BOOT literal")
	if _, err = os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("prompt was shell expanded")
	}
	// A new launcher instance adopts the same live session instead of duplicating it.
	tm2, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = tm2.Start(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err = tm2.Send(ctx, s.Handle, "safe follow-up"); err != nil {
		t.Fatal(err)
	}
	wait("RECEIVED safe follow-up")
	if err = tm2.Interrupt(ctx, s.Handle); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		i, e := tm2.Inspect(ctx, s.Handle)
		if e == nil && i.Dead {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("interrupt did not reach fake agent")
}

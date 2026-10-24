package agents

import (
	"context"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"slices"
	"testing"
)

func TestBypassForFreshAndResumedAgents(t *testing.T) {
	for _, id := range []string{"claude", "codex", "agy"} {
		for _, resume := range []bool{false, true} {
			t.Run(id+map[bool]string{true: "resume", false: "fresh"}[resume], func(t *testing.T) {
				p := domain.HarnessProfile{ID: id, Command: "/bin/echo", PromptMode: "arg", ResumeArgs: []string{"resume", "{conversation}"}}
				s := domain.Session{Harness: p, Prompt: "Do the task"}
				if resume {
					s.ConversationID = "conversation-123"
				}
				c, e := (CLI{}).Prepare(context.Background(), s, t.TempDir(), "/bin/echo")
				if e != nil {
					t.Fatal(e)
				}
				flag := "--dangerously-skip-permissions"
				if id == "codex" {
					flag = "--dangerously-bypass-approvals-and-sandbox"
				}
				if id == "codex" && !slices.Contains(c.Args, "--no-daemon") {
					t.Fatal("shared daemon can retain stale session credentials", c.Args)
				}
				if !slices.Contains(c.Args, flag) {
					t.Fatal(c.Args)
				}
				if resume && (!slices.Contains(c.Args, "conversation-123") || slices.Contains(c.Args, "Do the task")) {
					t.Fatal("resume lost identity", c.Args)
				}
			})
		}
	}
}
func TestInteractiveLaunchDoesNotSupplyEmptyPromptFlag(t *testing.T) {
	for _, id := range []string{"agy", "opencode"} {
		s := domain.Session{Harness: domain.HarnessProfile{ID: id, Command: "/bin/echo", Args: []string{"--prompt"}, PromptMode: "arg"}}
		c, e := (CLI{}).Prepare(context.Background(), s, t.TempDir(), "/bin/echo")
		if e != nil || slices.Contains(c.Args, "--prompt") {
			t.Fatal(c.Args, e)
		}
	}
}

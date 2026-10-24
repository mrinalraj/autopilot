// Package agents translates harness profiles into direct executable arguments.
// Launcher implementations do not need to know individual harness flags or hooks.
package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
)

type CLI struct{}

var _ plugins.Agent = CLI{}

func (CLI) Prepare(_ context.Context, s domain.Session, directory, autopilot string) (plugins.AgentCommand, error) {
	p := s.Harness
	args := append([]string{}, p.Args...)
	if s.ConversationID != "" {
		if len(p.ResumeArgs) == 0 {
			return plugins.AgentCommand{}, fmt.Errorf("harness cannot resume by conversation ID")
		}
		args = nil
		for _, arg := range p.ResumeArgs {
			args = append(args, strings.ReplaceAll(arg, "{conversation}", s.ConversationID))
		}
	} else if p.PromptMode == "arg" && s.Prompt != "" {
		args = append(args, s.Prompt)
	}
	if s.ConversationID == "" && s.Prompt == "" && (p.ID == "agy" || p.ID == "opencode") {
		filtered := args[:0]
		for _, arg := range args {
			if arg != "--prompt-interactive" && arg != "--prompt" {
				filtered = append(filtered, arg)
			}
		}
		args = filtered
	}
	// The personal runner launches supported harnesses in bypass mode, including resumes.
	flag := ""
	switch p.ID {
	case "claude", "agy":
		flag = "--dangerously-skip-permissions"
	case "codex":
		flag = "--dangerously-bypass-approvals-and-sandbox"
	}
	if flag != "" {
		found := false
		for _, v := range args {
			if v == flag {
				found = true
			}
		}
		if !found {
			args = append([]string{flag}, args...)
		}
	}
	// A shared Codex daemon can retain another generation's AUTOPILOT_* credentials.
	// Give each CLI its own server process and fresh launch environment.
	if p.ID == "codex" {
		found := false
		for _, arg := range args {
			found = found || arg == "--no-daemon"
		}
		if !found {
			args = append([]string{"--no-daemon"}, args...)
		}
	}
	executable, err := exec.LookPath(p.Command)
	if err != nil {
		return plugins.AgentCommand{}, err
	}
	if p.ID == "claude" {
		hooks := map[string]any{}
		// Claude executes hook commands through a shell; quote only our executable path.
		command := "'" + strings.ReplaceAll(autopilot, "'", "'\"'\"'") + "' hook"
		for _, event := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "PermissionRequest", "Notification"} {
			hooks[event] = []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 10}}}}
		}
		settings, err := json.Marshal(map[string]any{"hooks": hooks})
		if err != nil {
			return plugins.AgentCommand{}, err
		}
		file := filepath.Join(directory, "hooks.json")
		if err = os.WriteFile(file, settings, 0600); err != nil {
			return plugins.AgentCommand{}, err
		}
		args = append([]string{"--settings", file}, args...)
	}
	return plugins.AgentCommand{Executable: executable, Args: args}, nil
}

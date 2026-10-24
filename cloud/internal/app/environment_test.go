package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mrinalraj/autopilot/cloud/internal/repos"
)

func TestHostEnvironmentUsesExistingGitConfigWithoutLeakingParentSession(t *testing.T) {
	hostHome := t.TempDir()
	t.Setenv("HOME", hostHome)
	t.Setenv("USER", "local-test-user")
	t.Setenv("LOGNAME", "local-test-user")
	t.Setenv("SSH_AUTH_SOCK", filepath.Join(hostHome, "agent.sock"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(hostHome, "claude-config"))
	t.Setenv("CODEX_HOME", filepath.Join(hostHome, "codex-config"))
	t.Setenv("AUTOPILOT_TOKEN", "parent-token")
	t.Setenv("CLAUDECODE", "parent-session")
	t.Setenv("ANTHROPIC_API_KEY", "unrelated-secret")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(hostHome, ".gitconfig"))
	if err := os.WriteFile(filepath.Join(hostHome, ".gitconfig"), []byte("[user]\nname = Local Test User\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Config: cfg, APIURL: "http://127.0.0.1:4780"}
	values := func(env []string) map[string]string {
		m := map[string]string{}
		for _, v := range env {
			k, value, _ := strings.Cut(v, "=")
			m[k] = value
		}
		return m
	}
	isolated := values(a.baseEnv())
	if isolated["HOME"] != filepath.Join(cfg.DataDir, "agent-home") || isolated["SSH_AUTH_SOCK"] != "" || isolated["CLAUDE_CONFIG_DIR"] != "" {
		t.Fatal("default environment inherited host credentials")
	}
	a.Config.ExecutionEnvironment = "host"
	env := a.baseEnv()
	host := values(env)
	if host["HOME"] != hostHome || host["SSH_AUTH_SOCK"] != os.Getenv("SSH_AUTH_SOCK") || host["CLAUDE_CONFIG_DIR"] != os.Getenv("CLAUDE_CONFIG_DIR") || host["CODEX_HOME"] != os.Getenv("CODEX_HOME") {
		t.Fatal("host configuration locations not forwarded")
	}
	if host["USER"] != "local-test-user" || host["LOGNAME"] != "local-test-user" {
		t.Fatal("host account identity needed for Keychain was lost")
	}
	for _, key := range []string{"AUTOPILOT_TOKEN", "CLAUDECODE", "ANTHROPIC_API_KEY"} {
		if host[key] != "" {
			t.Fatalf("inherited %s", key)
		}
	}
	name, err := repos.Git(repos.WithEnvironment(context.Background(), env), hostHome, "config", "user.name")
	if err != nil || name != "Local Test User" {
		t.Fatalf("Git did not use host configuration: %q %v", name, err)
	}
}

func TestExecutionEnvironmentConfiguration(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"executionEnvironment":"host"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(dir)
	if err != nil || cfg.ExecutionEnvironment != "host" {
		t.Fatalf("host setting: %+v %v", cfg, err)
	}
	t.Setenv("AUTOPILOT_EXECUTION_ENVIRONMENT", "isolated")
	cfg, err = LoadConfig(dir)
	if err != nil || cfg.ExecutionEnvironment != "isolated" {
		t.Fatal("environment override ignored", err)
	}
	t.Setenv("AUTOPILOT_EXECUTION_ENVIRONMENT", "invalid")
	if _, err = LoadConfig(dir); err == nil {
		t.Fatal("invalid environment mode accepted")
	}
}

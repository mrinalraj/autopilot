package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

// Installation is explicit and versioned. There is no automatic upgrade on restart.
func installTool(args []string) error {
	if len(args) != 3 || args[0] != "install" {
		return fmt.Errorf("usage: autopilot tools install <claude|codex|opencode> <exact-version>; install agy from its official versioned release into /data/tools/bin")
	}
	packages := map[string]string{"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex", "opencode": "opencode-ai"}
	name := packages[args[1]]
	if name == "" || !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$`).MatchString(args[2]) {
		return fmt.Errorf("choose a supported harness and an exact semantic version")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	prefix := filepath.Join(cfg.DataDir, "tools", args[1])
	if err = os.MkdirAll(filepath.Join(cfg.DataDir, "agent-home"), 0700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "npm", "install", "--global", "--prefix", prefix, name+"@"+args[2])
	cmd.Env = append(os.Environ(), "HOME="+filepath.Join(cfg.DataDir, "agent-home"), "npm_config_update_notifier=false")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("harness install failed: %w", err)
	}
	binary := filepath.Join(prefix, "bin", args[1])
	if _, err = os.Stat(binary); err != nil {
		return fmt.Errorf("harness binary is unavailable on this platform: %w", err)
	}
	bindir := filepath.Join(cfg.DataDir, "tools", "bin")
	if err = os.MkdirAll(bindir, 0700); err != nil {
		return err
	}
	link := filepath.Join(bindir, args[1])
	tmp := link + ".next"
	os.Remove(tmp)
	if err = os.Symlink(binary, tmp); err != nil {
		return err
	}
	if err = os.Rename(tmp, link); err != nil {
		return err
	}
	fmt.Printf("Installed %s %s. Complete its login using HOME=%s %s\n", args[1], args[2], filepath.Join(cfg.DataDir, "agent-home"), link)
	return nil
}

func backup(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: autopilot backup <new-snapshot.sqlite>")
	}
	target, err := filepath.Abs(args[0])
	if err != nil {
		return err
	}
	if _, err = os.Lstat(target); !os.IsNotExist(err) {
		return fmt.Errorf("backup destination already exists")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	source := filepath.Join(cfg.DataDir, "autopilot.sqlite")
	if _, err = os.Stat(source); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if _, err = db.ExecContext(ctx, "VACUUM INTO ?", target); err != nil {
		return err
	}
	if err = os.Chmod(target, 0600); err != nil {
		return err
	}
	fmt.Println("Database snapshot saved to", target)
	return nil
}

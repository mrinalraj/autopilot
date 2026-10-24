package repos

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type environmentKey struct{}

func WithEnvironment(ctx context.Context, env []string) context.Context {
	return context.WithValue(ctx, environmentKey{}, env)
}

func Git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if env, ok := ctx.Value(environmentKey{}).([]string); ok {
		cmd.Env = append(append([]string{}, env...), "GIT_TERMINAL_PROMPT=0")
	}
	b, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(b)))
	}
	return strings.TrimSpace(string(b)), nil
}
func CanonicalPath(path string) (string, error) {
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}
func Inspect(ctx context.Context, path string) (remote, branch string, err error) {
	root, e := Git(ctx, path, "rev-parse", "--show-toplevel")
	if e != nil {
		return "", "", e
	}
	p, e := CanonicalPath(path)
	if e != nil {
		return "", "", e
	}
	r, e := CanonicalPath(root)
	if e != nil || r != p {
		return "", "", fmt.Errorf("select a repository root")
	}
	remote, _ = Git(ctx, p, "remote", "get-url", "origin")
	branch, _ = Git(ctx, p, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	branch = strings.TrimPrefix(branch, "origin/")
	if branch == "" {
		branch, _ = Git(ctx, p, "branch", "--show-current")
	}
	if branch == "" {
		branch = "main"
	}
	return remote, branch, nil
}
func Remote(raw string) (canonical, provider, repo string, err error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "git@") && !strings.Contains(raw, "://") {
		parts := strings.SplitN(raw, ":", 2)
		if len(parts) == 2 {
			raw = "ssh://" + parts[0] + "/" + parts[1]
		}
	}
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || !(u.Scheme == "https" || u.Scheme == "ssh") {
		return "", "", "", fmt.Errorf("use an HTTPS or SSH Git URL")
	}
	if u.RawQuery != "" || u.Fragment != "" || u.Path == "" || u.Path == "/" {
		return "", "", "", fmt.Errorf("invalid Git URL")
	}
	if u.User != nil {
		if _, ok := u.User.Password(); ok || u.Scheme == "https" {
			return "", "", "", fmt.Errorf("store credentials separately from repository URLs")
		}
	}
	repo = strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git")
	canonical = strings.ToLower(u.Hostname()) + "/" + repo
	switch strings.ToLower(u.Hostname()) {
	case "github.com":
		provider = "github"
	case "gitlab.com":
		provider = "gitlab"
	default:
		provider = "git"
	}
	return
}

var safeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$`)

func Clone(ctx context.Context, root, name, remote string) (string, error) {
	if !safeName.MatchString(name) || name == ".." {
		return "", fmt.Errorf("repository name must use letters, numbers, dots, underscores or hyphens")
	}
	if _, _, _, err := Remote(remote); err != nil {
		return "", err
	}
	root, err := CanonicalPath(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, name)
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return "", fmt.Errorf("destination already exists")
	}
	// Clone into an owned temporary path: never overwrite or remove a user's directory.
	tmp, err := os.MkdirTemp(root, ".clone-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	if _, err = Git(ctx, root, "clone", "--", remote, tmp); err != nil {
		return "", err
	}
	// Reserve the destination again after the network operation. A directory created
	// by the operator while cloning must not be replaced, even when it is empty.
	if err = os.Mkdir(target, 0700); err != nil {
		return "", fmt.Errorf("destination became unavailable: %w", err)
	}
	if err = os.Rename(tmp, target); err != nil {
		os.Remove(target) // Only remove our empty reservation, never a populated directory.
		return "", err
	}
	return target, nil
}
func Discover(ctx context.Context, root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		p := filepath.Join(root, entry.Name())
		if _, _, err := Inspect(ctx, p); err == nil {
			out = append(out, p)
		}
	}
	return out, nil
}
func Worktree(ctx context.Context, repo, target, branch, base string) (string, error) {
	if _, err := os.Stat(target); err == nil {
		current, e := Git(ctx, target, "branch", "--show-current")
		if e != nil || current != branch {
			return "", fmt.Errorf("existing worktree does not match this run")
		}
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return "", err
	}
	remote, _ := Git(ctx, repo, "remote", "get-url", "origin")
	if remote != "" {
		if _, err := Git(ctx, repo, "fetch", "--prune", "origin"); err != nil {
			return "", err
		}
		base = "origin/" + base
	}
	if _, err := Git(ctx, repo, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		_, err = Git(ctx, repo, "worktree", "add", "--", target, branch)
		return target, err
	}
	_, err := Git(ctx, repo, "worktree", "add", "-b", branch, "--", target, base)
	return target, err
}
func Risk(ctx context.Context, path string) (string, error) {
	dirty, err := Git(ctx, path, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if dirty != "" {
		return "uncommitted changes", nil
	}
	unpushed, err := Git(ctx, path, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return "", err
	}
	if unpushed != "0" {
		return "commits not present on a remote", nil
	}
	return "", nil
}

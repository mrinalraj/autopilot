package repos

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

type Checkout struct {
	Path, Branch, Head string
	Primary, Locked    bool
}

func ListWorktrees(ctx context.Context, root string) ([]Checkout, error) {
	raw, err := Git(ctx, root, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	out := []Checkout{}
	var current *Checkout
	for _, line := range strings.Split(raw, "\x00") {
		if strings.HasPrefix(line, "worktree ") {
			p := strings.TrimPrefix(line, "worktree ")
			if canonical, e := CanonicalPath(p); e == nil {
				p = canonical
			} else {
				p, _ = filepath.Abs(p)
			}
			out = append(out, Checkout{Path: p, Primary: len(out) == 0})
			current = &out[len(out)-1]
		} else if current != nil {
			if strings.HasPrefix(line, "branch ") {
				current.Branch = strings.TrimPrefix(line, "branch refs/heads/")
			}
			if strings.HasPrefix(line, "HEAD ") {
				current.Head = strings.TrimPrefix(line, "HEAD ")
			}
			if strings.HasPrefix(line, "locked") {
				current.Locked = true
			}
		}
	}
	return out, nil
}
func Branches(ctx context.Context, root string) ([]string, error) {
	raw, err := Git(ctx, root, "for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/")
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, ref := range strings.Split(raw, "\n") {
		if ref != "" && !strings.HasSuffix(ref, "/HEAD") {
			out = append(out, ref)
		}
	}
	return out, nil
}
func CreateWorktree(ctx context.Context, root, path, branch, base string) error {
	if strings.HasPrefix(branch, "-") {
		return fmt.Errorf("invalid branch name")
	}
	if _, err := Git(ctx, root, "check-ref-format", "--branch", branch); err != nil {
		return err
	}
	if !strings.HasPrefix(base, "refs/heads/") && !strings.HasPrefix(base, "refs/remotes/") {
		return fmt.Errorf("choose a local or remote base branch")
	}
	if _, err := Git(ctx, root, "rev-parse", "--verify", base+"^{commit}"); err != nil {
		return fmt.Errorf("base branch has no commit; fetch or create an initial commit first")
	}
	_, err := Git(ctx, root, "worktree", "add", "-b", branch, "--", path, base)
	return err
}

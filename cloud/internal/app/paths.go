package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDataDir is independent of the checkout and current working directory.
// Container deployments explicitly select /data with AUTOPILOT_DATA_DIR.
func DefaultDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", fmt.Errorf("cannot locate user home; set AUTOPILOT_DATA_DIR")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Autopilot Cloud"), nil
	}
	base := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(base) {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "autopilot-cloud"), nil
}

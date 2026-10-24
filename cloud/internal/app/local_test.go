package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalDefaultsAndExplicitSettings(t *testing.T) {
	for _, key := range []string{"AUTOPILOT_EXECUTION_ENVIRONMENT", "AUTOPILOT_LISTEN", "AUTOPILOT_ALLOWED_HOSTS"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	local, e := LoadLocalConfig(dir)
	if e != nil {
		t.Fatal(e)
	}
	server, e := LoadConfig(dir)
	if e != nil {
		t.Fatal(e)
	}
	if local.ExecutionEnvironment != "host" || server.ExecutionEnvironment != "isolated" || local.Address != "127.0.0.1:4780" {
		t.Fatal(local, server)
	}
	if e = os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"executionEnvironment":"isolated","maxWorkers":2}`), 0600); e != nil {
		t.Fatal(e)
	}
	local, e = LoadLocalConfig(dir)
	if e != nil || local.ExecutionEnvironment != "isolated" || local.MaxWorkers != 2 {
		t.Fatal(local, e)
	}
	t.Setenv("AUTOPILOT_EXECUTION_ENVIRONMENT", "host")
	local, e = LoadLocalConfig(dir)
	if e != nil || local.ExecutionEnvironment != "host" {
		t.Fatal(local, e)
	}
	if e = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("bad json"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadLocalConfig(dir); e == nil {
		t.Fatal("malformed settings accepted")
	}
}

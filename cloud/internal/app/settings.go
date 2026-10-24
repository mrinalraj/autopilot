package app

import (
	"context"
	"encoding/json"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
	"github.com/mrinalraj/autopilot/cloud/internal/plugins"
	"os"
	"path/filepath"
)

func (a *App) Settings() any {
	return map[string]any{"distribution": "cloud", "executionEnvironment": a.Config.ExecutionEnvironment, "dataDirectory": a.Config.DataDir, "maxWorkers": a.Config.MaxWorkers, "maxOrchestrators": a.Config.MaxOrchestrators, "retentionDays": a.Config.RetentionDays, "profiles": a.Plugins.AllProfiles()}
}
func (a *App) SaveProfile(ctx context.Context, p domain.HarnessProfile) error {
	if e := plugins.ValidateProfile(p); e != nil {
		return e
	}
	a.Operations.Lock()
	defer a.Operations.Unlock()
	all := a.Plugins.AllProfiles()
	found := false
	for n, v := range all {
		if v.ID == p.ID {
			all[n] = p
			found = true
		}
	}
	if !found {
		all = append(all, p)
	}
	raw, e := json.MarshalIndent(all, "", "  ")
	if e != nil {
		return e
	}
	tmp := filepath.Join(a.Config.DataDir, "profiles.json.next")
	if e = os.WriteFile(tmp, raw, 0600); e != nil {
		return e
	}
	if e = os.Rename(tmp, filepath.Join(a.Config.DataDir, "profiles.json")); e != nil {
		return e
	}
	a.Plugins.SetProfile(p)
	a.Store.Notify()
	return nil
}

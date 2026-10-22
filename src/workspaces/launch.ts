import type { Config, LauncherName } from "../config/config";
import type { Launcher } from "./types";
import { git, editor, worktrunk } from "./builtins";
import { supacode } from "./supacode";
import { superset } from "./superset";

export type { Launcher, SessionRequest } from "./types";
export { worktreeId, pathFromId } from "../domain/worktree";
export { shellQuote, claudeCommand, listWorktrees, worktreeForBranch } from "./common";
export { runInTerminal, ideChatUrl, ideWorkspace, IDE_DIR } from "./builtins";

/** All provider-specific behavior is behind this registry. Unknown names never open another app. */
const adapters: Record<LauncherName, (cfg: Config) => Launcher> = {
  supacode, superset, git, worktrunk,
  vscode: (cfg) => editor(cfg, "vscode"),
  cursor: (cfg) => editor(cfg, "cursor"),
};

/** The configured launcher controls every ticket, including work imported from another tool. */
export function launcherFor(cfg: Config): Launcher {
  const factory = adapters[cfg.launch.launcher];
  if (!Object.hasOwn(adapters, cfg.launch.launcher)) throw new Error(`Unknown launcher "${cfg.launch.launcher}"; choose one in Settings`);
  return factory(cfg);
}

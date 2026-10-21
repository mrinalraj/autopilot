import type { LauncherName } from "../config/config";

/**
 * Launchers create a ticket's worktrees and open its Claude session. Worktrees are identified
 * by their percent-encoded path, independently of the selected tool.
 */
export interface Launcher {
  name: LauncherName;
  /** Returns the worktree path for `branch` in `repoPath`, creating it unless one exists. */
  ensureWorktree(repoPath: string, branch: string, background: boolean): Promise<string>;
  /** Register an existing worktree in place; never recreate it or start a session. */
  adoptWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void>;
  openSession(req: SessionRequest): Promise<void>;
  resendPrompt?: (req: SessionRequest) => Promise<void>;
  removeWorktree(repoPath: string, worktreePath: string, branch: string, force: boolean): Promise<void>;
  /** Link that opens the worktree in its tool, if it has one. */
  link(worktreePath: string): string | null | Promise<string | null>;
}

export interface SessionRequest {
  identifier: string;
  /** The ticket brief, and the extra repos' names, for launchers that build their own prompt (IDE chat). */
  briefPath: string;
  others: { repo: string; path: string }[];
  /** Worktree the session starts in (the primary repo's). */
  primaryPath: string;
  /** Extra repos' worktrees, added to the session (and editor workspace). */
  otherPaths: string[];
  prompt: string;
  /** Directories the session may use without prompting: the briefs dir and the extra worktrees. */
  addDirs: string[];
  background: boolean;
}

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config, LauncherName } from "../config/config";
import { log } from "../shared/log";
import { notify } from "../platform/notify";
import { initPrompt } from "../triage/brief";
import { step } from "../app/steps";
import { run, shellQuote, claudeCommand, worktreeForBranch, fetchOrigin, assertWorktree } from "./common";
import type { Launcher, SessionRequest } from "./types";


/* ---------- Plain git worktrees ---------- */

async function defaultBase(repoPath: string): Promise<string> {
  return (await run(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "origin/HEAD"], 30_000).catch(() => "")) || "origin/main";
}

async function gitWorktreeAdd(cfg: Config, repoPath: string, branch: string): Promise<string> {
  const existing = await worktreeForBranch(repoPath, branch);
  if (existing) return existing;
  // Clear entries for worktree folders deleted by hand, or git refuses to check the branch out again.
  await run(["git", "-C", repoPath, "worktree", "prune"], 30_000).catch(() => {});
  if (cfg.launch.fetch) await fetchOrigin(repoPath);
  const path = join(cfg.launch.worktreesDir, basename(repoPath), branch);
  mkdirSync(dirname(path), { recursive: true });
  step(`Creating the worktree in ${basename(repoPath)} (git worktree add)…`);
  const branchExists = await run(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 30_000).then(
    () => true,
    () => false,
  );
  if (branchExists) await run(["git", "-C", repoPath, "worktree", "add", path, branch], 120_000);
  else await run(["git", "-C", repoPath, "worktree", "add", "-b", branch, path, cfg.launch.base || (await defaultBase(repoPath))], 120_000);
  step(`Worktree ready: ${path}`);
  return path;
}

async function gitWorktreeRemove(repoPath: string, worktreePath: string, force: boolean) {
  await run(["git", "-C", repoPath, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath], 120_000);
}

/** Runs a one-off interactive command (e.g. `gh auth login`) in a new iTerm or Terminal window. */
export async function runInTerminal(cfg: Config, command: string) {
  if (cfg.launch.terminal === "iterm") {
    await run(["osascript", "-e", "on run argv", "-e", 'tell application "iTerm"', "-e", "activate", "-e", "create window with default profile",
      "-e", "tell current session of current window to write text (item 1 of argv)", "-e", "end tell", "-e", "end run", command], 60_000);
    return;
  }
  await run(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal"', "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", command], 60_000);
}

/**
 * Opens a new tab in the worktree and starts `claude` there. Text reaches AppleScript as argv,
 * never as code. Terminal has no "new tab" command: ⌘T via System Events needs Accessibility, and
 * without it the session opens in a new window instead.
 */
async function openTerminal(cfg: Config, req: SessionRequest) {
  const terminal = cfg.launch.terminal;
  if (terminal === "none") {
    log.info(`worktrees ready for ${req.identifier}; no terminal configured, so no session was opened`);
    return;
  }
  const claude = claudeCommand(cfg, req);
  const command = `cd ${shellQuote(req.primaryPath)} && ${claude}`;
  step(`Opening a ${terminal === "iterm" ? "iTerm" : terminal === "warp" ? "Warp" : "Terminal"} tab with Claude…`);

  if (terminal === "warp") {
    // Warp's URI scheme opens a tab in a folder but can't run a command, so the command goes on the
    // clipboard for one paste.
    await run(["open", `warp://action/new_tab?path=${encodeURIComponent(req.primaryPath)}`], 30_000);
    const copy = Bun.spawn(["pbcopy"], { stdin: "pipe", env: process.env });
    copy.stdin.write(claude);
    await copy.stdin.end();
    await copy.exited;
    await notify({
      title: `${req.identifier}: Warp tab ready`,
      message: "The claude command is on your clipboard; paste it in the new Warp tab.",
      openUrl: `warp://action/new_tab?path=${encodeURIComponent(req.primaryPath)}`,
      group: `${req.identifier}-warp`,
    });
  } else if (terminal === "iterm") {
    await run(["osascript", "-e", "on run argv", "-e", 'tell application "iTerm"', "-e", "activate",
      "-e", "if (count of windows) = 0 then", "-e", "create window with default profile", "-e", "else",
      "-e", "tell current window to create tab with default profile", "-e", "end if",
      "-e", "tell current session of current window to write text (item 1 of argv)", "-e", "end tell", "-e", "end run", command], 60_000);
  } else {
    const tab = await run(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal"', "-e", "activate",
      "-e", "if (count of windows) = 0 then", "-e", "do script (item 1 of argv)", "-e", "return", "-e", "end if", "-e", "end tell",
      "-e", 'tell application "System Events" to keystroke "t" using command down', "-e", "delay 0.4",
      "-e", 'tell application "Terminal" to do script (item 1 of argv) in front window', "-e", "end run", command], 60_000).then(
      () => true,
      (err) => {
        log.warn("could not open a Terminal tab (System Events needs Accessibility permission); using a new window", err);
        return false;
      },
    );
    if (!tab) await run(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal"', "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", command], 60_000);
  }
  log.info(`launched claude in ${req.primaryPath} (${terminal})`);
}

export function git(cfg: Config): Launcher {
  return {
    name: "git",
    adoptWorktree: assertWorktree,
    ensureWorktree: (repoPath, branch) => gitWorktreeAdd(cfg, repoPath, branch),
    openSession: (req) => openTerminal(cfg, req),
    removeWorktree: (repoPath, worktreePath, _branch, force) => gitWorktreeRemove(repoPath, worktreePath, force),
    link: () => null,
  };
}

/* ---------- Worktrunk (wt): its own worktree layout and hooks ---------- */

export function worktrunk(cfg: Config): Launcher {
  const wt = () => Bun.which("wt", { PATH: process.env.PATH }) ?? "wt";
  return {
    name: "worktrunk",
    adoptWorktree: assertWorktree,
    async ensureWorktree(repoPath, branch) {
      const existing = await worktreeForBranch(repoPath, branch);
      if (existing) return existing;
      if (cfg.launch.fetch) await fetchOrigin(repoPath);
      step(`Creating the worktree in ${basename(repoPath)} with Worktrunk (its hooks run now)…`);
      const args = [wt(), "-C", repoPath, "switch", "--create", branch, "--no-cd", "-y"];
      if (cfg.launch.base) args.push("--base", cfg.launch.base);
      await run(args, 330_000);
      const path = await worktreeForBranch(repoPath, branch);
      if (!path) throw new Error(`wt switch --create did not leave a worktree for ${branch} in ${repoPath}`);
      return path;
    },
    openSession: (req) => openTerminal(cfg, req),
    async removeWorktree(repoPath, worktreePath, branch, force) {
      // Keep the branch (it may back an open PR); fall back to git if wt refuses.
      try {
        await run([wt(), "-C", repoPath, "remove", branch, "--no-delete-branch", "--foreground", "-y"], 150_000);
      } catch (err) {
        if (!force) throw err;
        await gitWorktreeRemove(repoPath, worktreePath, true);
      }
    },
    link: () => null,
  };
}

/* ---------- VS Code / Cursor: git worktrees opened as one workspace, Claude in a terminal ---------- */

/** Chat link that opens the editor's chat panel with `prompt` pre-filled (never auto-sent). */
export function ideChatUrl(editorName: "vscode" | "cursor", cursorChat: "cursor" | "claude", prompt: string): string {
  const q = encodeURIComponent(prompt);
  if (editorName === "cursor" && cursorChat === "cursor") return `cursor://anysphere.cursor-deeplink/prompt?text=${q}`;
  return `${editorName}://anthropic.claude-code/open?prompt=${q}`;
}

/** Hidden folder in the primary worktree for the brief and workspace file (excluded from git). */
export const IDE_DIR = ".autopilot";

/**
 * Puts the ticket's brief (and, for several repos, a multi-root workspace file) inside the primary
 * worktree, so trusting the worktrees folder once in the editor covers it: Claude's extension
 * doesn't run in Restricted Mode, and a workspace is only trusted if every folder in it is.
 * Returns what to open (folder or workspace file) and the in-worktree brief path.
 */
export async function ideWorkspace(req: SessionRequest): Promise<{ target: string; brief: string }> {
  const dir = join(req.primaryPath, IDE_DIR);
  mkdirSync(dir, { recursive: true });
  const brief = join(dir, `${req.identifier}-brief.md`);
  if (existsSync(brief)) chmodSync(brief, 0o644);
  copyFileSync(req.briefPath, brief);
  chmodSync(brief, 0o444);
  // Keep it out of git status and commits (info/exclude is shared by all worktrees of the repo).
  const common = await run(["git", "-C", req.primaryPath, "rev-parse", "--git-common-dir"], 30_000).catch(() => "");
  if (common) {
    const exclude = join(common.startsWith("/") ? common : join(req.primaryPath, common), "info", "exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split("\n").includes(`${IDE_DIR}/`)) writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${IDE_DIR}/\n`);
  }
  if (!req.otherPaths.length) return { target: req.primaryPath, brief };
  const target = join(dir, `${req.identifier}.code-workspace`);
  writeFileSync(target, JSON.stringify({ folders: [req.primaryPath, ...req.otherPaths].map((path) => ({ path })) }, null, 2) + "\n");
  return { target, brief };
}

const appRunning = (app: string) => Bun.spawnSync(["pgrep", "-xq", app === "Visual Studio Code" ? "Code" : app]).exitCode === 0;

export function editor(cfg: Config, name: "vscode" | "cursor"): Launcher {
  const app = name === "vscode" ? "Visual Studio Code" : "Cursor";
  return {
    name,
    adoptWorktree: assertWorktree,
    ...(cfg.launch.ideSession === "chat" ? { resendPrompt: (req: SessionRequest) => resendIdePrompt(cfg, name, req) } : {}),
    ensureWorktree: (repoPath, branch) => gitWorktreeAdd(cfg, repoPath, branch),
    async openSession(req) {
      if (cfg.launch.ideSession === "terminal") {
        // One repo opens as a folder; several as a multi-root workspace in one window.
        let target = req.primaryPath;
        if (req.otherPaths.length) {
          const dir = join(cfg.stateDir, "workspaces");
          mkdirSync(dir, { recursive: true });
          target = join(dir, `${req.identifier}.code-workspace`);
          writeFileSync(target, JSON.stringify({ folders: [req.primaryPath, ...req.otherPaths].map((path) => ({ path })) }, null, 2) + "\n");
        }
        await run(["open", "-a", app, target], 60_000);
        await openTerminal(cfg, req);
        return;
      }
      // Chat panel: open the workspace, give the window time to appear (longer on a cold start),
      // then hand the prompt to the chat. The link goes to the focused window, which is this one.
      const { target, brief } = await ideWorkspace(req);
      const wasRunning = appRunning(app);
      step(`Opening ${app}…`);
      await run(["open", "-a", app, target], 60_000);
      step(wasRunning ? `Waiting for the ${app} window…` : `Waiting for ${app} to start…`);
      await Bun.sleep(wasRunning ? 2_500 : 8_000);
      step(`Sending the prompt to ${name === "cursor" && cfg.launch.cursorChat === "cursor" ? "Cursor's" : "Claude's"} chat…`);
      await run(["open", ideChatUrl(name, cfg.launch.cursorChat, initPrompt(brief, req.others))], 30_000);
      log.info(`opened ${app} for ${req.identifier} with the prompt in its chat (press Enter there to start)`);
      log.info(`If ${app} shows Restricted Mode, trust the folder, then use "Send prompt to chat" on the ticket.`);
    },
    removeWorktree: (repoPath, worktreePath, _branch, force) => gitWorktreeRemove(repoPath, worktreePath, force),
    link: (path) => `${name}://file${pathToFileURL(path).pathname}`,
  };
}

/**
 * Re-sends a launched ticket's prompt to its editor chat (e.g. after trusting the workspace).
 * Recreates the in-worktree brief first, which also upgrades tickets launched before it existed.
 */
export async function resendIdePrompt(cfg: Config, editorName: "vscode" | "cursor", req: SessionRequest) {
  const { brief } = await ideWorkspace(req);
  await run(["open", ideChatUrl(editorName, cfg.launch.cursorChat, initPrompt(brief, req.others))], 30_000);
}

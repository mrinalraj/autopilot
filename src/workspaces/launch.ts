import { supacodeId, pathFromId } from "../domain/worktree";
export { supacodeId, pathFromId } from "../domain/worktree";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config, LauncherName } from "../config/config";
import { log } from "../shared/log";
import { notify } from "../platform/notify";
import { initPrompt } from "../triage/brief";
import { step } from "../app/steps";

/**
 * Launchers create a ticket's worktrees and open its Claude session. Worktrees are identified
 * everywhere by their percent-encoded path (Supacode's ID format), whichever tool made them.
 */
export interface Launcher {
  name: LauncherName;
  /** Returns the worktree path for `branch` in `repoPath`, creating it unless one exists. */
  ensureWorktree(repoPath: string, branch: string, background: boolean): Promise<string>;
  openSession(req: SessionRequest): Promise<void>;
  removeWorktree(repoPath: string, worktreePath: string, branch: string, force: boolean): Promise<void>;
  /** Link that opens the worktree in its tool, if it has one. */
  link(worktreePath: string): string | null;
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

async function run(argv: string[], timeoutMs = 300_000): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`);
  return stdout.trim();
}

// The prompt must come before --add-dir: that option is variadic and would swallow it as a directory.
export const claudeCommand = (cfg: Config, req: Pick<SessionRequest, "prompt" | "addDirs">) =>
  `${cfg.launch.claudeBin} ${shellQuote(req.prompt)} --add-dir ${req.addDirs.map(shellQuote).join(" ")}`;

const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";



export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Every worktree of a repo (besides the main checkout) with its branch (read-only git). */
export async function listWorktrees(repoPath: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await run(["git", "-C", repoPath, "worktree", "list", "--porcelain"], 30_000);
  const items: { path: string; branch: string | null }[] = [];
  for (const block of out.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    if (/^prunable/m.test(block) || !existsSync(path)) continue; // folder deleted by hand; git still lists it
    items.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return items.slice(1); // the first entry is the repo's main checkout
}

/** Path of the existing git worktree checked out on `branch`, if any. */
export async function worktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  return (await listWorktrees(repoPath)).find((w) => w.branch === branch)?.path ?? null;
}

/**
 * Fetches with your own git rather than Supacode's --fetch: the app runs /usr/bin/git, whose
 * Keychain credential helper isn't trusted for github.com, so every launch raised a Keychain prompt.
 */
async function fetchOrigin(repoPath: string) {
  step(`Fetching origin in ${basename(repoPath)}…`);
  try {
    await run(["git", "-C", repoPath, "fetch", "origin", "--quiet"], 120_000);
  } catch (err) {
    log.warn(`git fetch failed in ${repoPath}; creating the worktree from the last fetched base`, err);
  }
}

/** Worktree paths Supacode manages, to attribute imported worktrees to the right launcher. */
export async function supacodeWorktreePaths(cfg: Config): Promise<Set<string>> {
  if (!existsSync(cfg.launch.supacodeBin)) return new Set();
  try {
    return new Set((await run([cfg.launch.supacodeBin, "worktree", "list"], 30_000)).split("\n").filter(Boolean).map(pathFromId));
  } catch {
    return new Set();
  }
}

/* ---------- Supacode: worktree and Claude tab in the app ---------- */

function supacode(cfg: Config): Launcher {
  const sc = cfg.launch.supacodeBin;
  const useCli = () => existsSync(sc);
  return {
    name: "supacode",
    async ensureWorktree(repoPath, branch, background) {
      const existing = await worktreeForBranch(repoPath, branch);
      if (existing) {
        step(`Reusing the existing worktree in ${basename(repoPath)}`);
        return existing;
      }
      if (cfg.launch.fetch) await fetchOrigin(repoPath);
      const repoId = supacodeId(repoPath);

      if (useCli()) {
        if (!(await run([sc, "repo", "list"], 30_000)).split("\n").includes(repoId)) {
          log.info(`registering ${repoPath} with Supacode`);
          await run([sc, "repo", "open", repoPath], 60_000);
        }
        step(`Creating the worktree in ${basename(repoPath)} with Supacode (its hooks run now)…`);
        const args = [sc, "repo", "worktree-new", "-r", repoId, "--branch", branch, "--timeout", "300"];
        if (cfg.launch.base) args.push("--base", cfg.launch.base);
        if (background) args.push("--background");
        const id = lastLine(await run(args, 330_000));
        if (!id) throw new Error(`supacode repo worktree-new printed no worktree ID for ${repoPath}`);
        return pathFromId(id);
      }

      // Deeplink fallback when the CLI binary is missing.
      const q = new URLSearchParams({ branch });
      if (cfg.launch.base) q.set("base", cfg.launch.base);
      if (background) q.set("background", "true");
      await run(["open", `supacode://repo/${repoId}/worktree/new?${q}`], 30_000);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await Bun.sleep(2_000);
        const path = await worktreeForBranch(repoPath, branch);
        if (path) return path;
      }
      throw new Error(`Supacode did not create the worktree for ${repoPath} within 180s (deeplink)`);
    },
    async openSession(req) {
      const command = claudeCommand(cfg, req);
      const title = `${req.identifier} claude`;
      const id = supacodeId(req.primaryPath);
      if (useCli()) {
        step("Opening a Claude tab in Supacode…");
        const args = [sc, "tab", "new", "-w", id, "--title", title, "-i", command];
        if (req.background) args.push("--background");
        const tabId = lastLine(await run(args, 60_000));
        log.info(`launched claude in ${req.primaryPath} (tab ${tabId})`);
        return;
      }
      const q = new URLSearchParams({ input: command, title });
      await run(["open", `supacode://worktree/${id}/tab/new?${q}`], 30_000);
    },
    // Supacode also closes the worktree's terminals, including the Claude session.
    async removeWorktree(_repoPath, worktreePath) {
      const id = supacodeId(worktreePath);
      if (useCli()) await run([sc, "worktree", "delete", "-w", id, "--background", "--timeout", "120"], 150_000);
      else await run(["open", `supacode://worktree/${id}/delete?background=true`], 30_000);
    },
    link: (path) => `supacode://worktree/${supacodeId(path)}`,
  };
}

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

function git(cfg: Config): Launcher {
  return {
    name: "git",
    ensureWorktree: (repoPath, branch) => gitWorktreeAdd(cfg, repoPath, branch),
    openSession: (req) => openTerminal(cfg, req),
    removeWorktree: (repoPath, worktreePath, _branch, force) => gitWorktreeRemove(repoPath, worktreePath, force),
    link: () => null,
  };
}

/* ---------- Worktrunk (wt): its own worktree layout and hooks ---------- */

function worktrunk(cfg: Config): Launcher {
  const wt = () => Bun.which("wt", { PATH: process.env.PATH }) ?? "wt";
  return {
    name: "worktrunk",
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

function editor(cfg: Config, name: "vscode" | "cursor"): Launcher {
  const app = name === "vscode" ? "Visual Studio Code" : "Cursor";
  return {
    name,
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
    link: (path) => `${name}://file${encodeURI(path)}`,
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

/** The launcher by name; a ticket's stored launcher wins over the configured one. */
export function launcherFor(cfg: Config, name?: string | null): Launcher {
  switch (name ?? cfg.launch.launcher) {
    case "worktrunk":
      return worktrunk(cfg);
    case "git":
      return git(cfg);
    case "vscode":
      return editor(cfg, "vscode");
    case "cursor":
      return editor(cfg, "cursor");
    default:
      return supacode(cfg);
  }
}

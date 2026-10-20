import { existsSync } from "node:fs";
import type { Config } from "./config";
import { log } from "./log";

export interface TabRequest {
  identifier: string;
  /** Worktree the session starts in (the primary repo's). */
  worktreeId: string;
  prompt: string;
  /** Directories the session may use without prompting: the briefs dir and any extra worktrees. */
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
export const claudeCommand = (cfg: Config, req: TabRequest) =>
  `${cfg.launch.claudeBin} ${shellQuote(req.prompt)} --add-dir ${req.addDirs.map(shellQuote).join(" ")}`;

const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** Supacode IDs are the percent-encoded absolute path with a trailing slash. */
export const supacodeId = (path: string) => encodeURIComponent(path.endsWith("/") ? path : `${path}/`);

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Path of the existing git worktree checked out on `branch`, if any (read-only git). */
async function worktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  const out = await run(["git", "-C", repoPath, "worktree", "list", "--porcelain"], 30_000);
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

/**
 * Fetches with your own git rather than Supacode's --fetch: the app runs /usr/bin/git, whose
 * Keychain credential helper isn't trusted for github.com, so every launch raised a Keychain prompt.
 */
async function fetchOrigin(repoPath: string) {
  try {
    await run(["git", "-C", repoPath, "fetch", "origin", "--quiet"], 120_000);
  } catch (err) {
    log.warn(`git fetch failed in ${repoPath}; creating the worktree from the last fetched base`, err);
  }
}

const useCli = (cfg: Config) => existsSync(cfg.launch.supacodeBin);

/**
 * Returns the Supacode worktree for `branch` in `repoPath`, creating it through Supacode (so its
 * branch creation and hooks run) unless one already exists, e.g. when retrying a failed launch.
 */
export async function ensureWorktree(cfg: Config, repoPath: string, branch: string, background: boolean): Promise<string> {
  const existing = await worktreeForBranch(repoPath, branch);
  if (existing) {
    log.info(`reusing existing worktree ${existing}`);
    return supacodeId(existing);
  }
  if (cfg.launch.fetch) await fetchOrigin(repoPath);
  const repoId = supacodeId(repoPath);

  if (useCli(cfg)) {
    const sc = cfg.launch.supacodeBin;
    if (!(await run([sc, "repo", "list"], 30_000)).split("\n").includes(repoId)) {
      log.info(`registering ${repoPath} with Supacode`);
      await run([sc, "repo", "open", repoPath], 60_000);
    }
    const args = [sc, "repo", "worktree-new", "-r", repoId, "--branch", branch, "--timeout", "300"];
    if (cfg.launch.base) args.push("--base", cfg.launch.base);
    if (background) args.push("--background");
    const id = lastLine(await run(args, 330_000));
    if (!id) throw new Error(`supacode repo worktree-new printed no worktree ID for ${repoPath}`);
    return id;
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
    if (path) return supacodeId(path);
  }
  throw new Error(`Supacode did not create the worktree for ${repoPath} within 180s (deeplink)`);
}

/** Opens a tab in the worktree running `claude` with the init prompt. */
export async function openClaudeTab(cfg: Config, req: TabRequest): Promise<void> {
  const command = claudeCommand(cfg, req);
  const title = `${req.identifier} claude`;
  if (useCli(cfg)) {
    const args = [cfg.launch.supacodeBin, "tab", "new", "-w", req.worktreeId, "--title", title, "-i", command];
    if (req.background) args.push("--background");
    const tabId = lastLine(await run(args, 60_000));
    log.info(`launched claude in ${decodeURIComponent(req.worktreeId)} (tab ${tabId})`);
    return;
  }
  const q = new URLSearchParams({ input: command, title });
  await run(["open", `supacode://worktree/${req.worktreeId}/tab/new?${q}`], 30_000);
}

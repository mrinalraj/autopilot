import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "../config/config";
import type { SessionRequest } from "./types";
import { step } from "../app/steps";
import { log } from "../shared/log";

export async function run(argv: string[], timeoutMs = 300_000): Promise<string> {
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
  `${shellQuote(cfg.launch.claudeBin)} ${shellQuote(req.prompt)} --add-dir ${req.addDirs.map(shellQuote).join(" ")}`;

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

export const canonicalPath = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);

/** Adoption must never target a main checkout, another repo, or a different branch. */
export async function assertWorktree(repoPath: string, path: string, branch: string): Promise<void> {
  const matches = (await listWorktrees(repoPath)).filter((w) => canonicalPath(w.path) === canonicalPath(path));
  if (matches.length !== 1 || matches[0].branch !== branch) {
    throw new Error(`Refusing to use ${path}: it is not an isolated worktree of ${repoPath} on ${branch}`);
  }
}

/**
 * Fetches with your own git rather than Supacode's --fetch: the app runs /usr/bin/git, whose
 * Keychain credential helper isn't trusted for github.com, so every launch raised a Keychain prompt.
 */
export async function fetchOrigin(repoPath: string) {
  step(`Fetching origin in ${basename(repoPath)}…`);
  try {
    await run(["git", "-C", repoPath, "fetch", "origin", "--quiet"], 120_000);
  } catch (err) {
    log.warn(`git fetch failed in ${repoPath}; creating the worktree from the last fetched base`, err);
  }
}

import { existsSync } from "node:fs";

import type { WorkStatus } from "../domain/work";
export type { WorkStatus, RepoWork, WorkStage } from "../domain/work";
export { atRisk, stage, overallStage, isSettled, workFingerprint } from "../domain/work";

async function out(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1]}: ${(stderr || stdout).trim().slice(0, 200)}`);
  return stdout.trim();
}

/** The account PR checks run as: the pinned one, else gh's active account ("" when gh isn't set up). */
export async function githubAccount(pinned: string): Promise<string> {
  return pinned || out(["gh", "config", "get", "-h", "github.com", "user"], "/").catch(() => "");
}

let cachedToken: { user: string; token: string; at: number } | null = null;

/**
 * Environment for `gh` pinned to `user`, so PR tracking doesn't depend on which account is active.
 * The token stays in memory (refreshed hourly) and is never logged or written.
 */
export async function ghEnv(user: string): Promise<Record<string, string | undefined>> {
  if (!user) return process.env;
  if (!cachedToken || cachedToken.user !== user || Date.now() - cachedToken.at > 3_600_000) {
    const token = await out(["gh", "auth", "token", "-h", "github.com", "-u", user], "/");
    cachedToken = { user, token, at: Date.now() };
  }
  return { ...process.env, GH_TOKEN: cachedToken.token };
}

export async function checkWork(worktreeId: string, repoPath: string, branch: string, githubUser = ""): Promise<WorkStatus> {
  const worktreePath = decodeURIComponent(worktreeId).replace(/\/$/, "");
  const status: WorkStatus = {
    checkedAt: new Date().toISOString(),
    worktreePath,
    missing: !existsSync(worktreePath),
    commitsAhead: null,
    unpushed: null,
    dirtyFiles: null,
    lastCommitAt: null,
    pr: null,
    error: null,
  };
  const errors: string[] = [];

  if (!status.missing) {
    // Each check stands alone so one failing (e.g. no origin) can't hide another, like dirty files.
    const git = (...args: string[]) => out(["git", ...args], worktreePath).catch((err) => {
      errors.push((err as Error).message);
      return null;
    });
    const dirty = await git("status", "--porcelain");
    if (dirty !== null) status.dirtyFiles = dirty.split("\n").filter(Boolean).length;
    const base = (await out(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], worktreePath).catch(() => null)) ?? "origin/main";
    const ahead = await git("rev-list", "--count", `${base}..HEAD`);
    if (ahead !== null) status.commitsAhead = Number(ahead);
    if (status.commitsAhead) status.lastCommitAt = (await git("log", "-1", "--format=%cI")) || null;
    status.unpushed = await out(["git", "rev-list", "--count", "@{u}..HEAD"], worktreePath)
      .then(Number)
      .catch(() => status.commitsAhead);
  }

  // gh resolves the GitHub repo from the checkout's remote; the main repo works if the worktree is gone.
  try {
    const prs = JSON.parse(
      await out(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state,isDraft,title"],
        status.missing ? repoPath : worktreePath, await ghEnv(githubUser)),
    ) as WorkStatus["pr"][];
    status.pr = prs[0] ?? null;
  } catch (err) {
    errors.push((err as Error).message);
  }

  status.error = errors.length ? errors.join("; ") : null;
  return status;
}

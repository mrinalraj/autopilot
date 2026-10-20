import { existsSync } from "node:fs";

/** What the launched session has done so far, read from its worktree and GitHub. Read-only. */
export interface WorkStatus {
  checkedAt: string;
  worktreePath: string;
  missing: boolean;
  commitsAhead: number | null;
  /** Commits not on the remote: ahead of the upstream, or all of them if never pushed. */
  unpushed: number | null;
  dirtyFiles: number | null;
  lastCommitAt: string | null;
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean; title: string } | null;
  error: string | null;
}

/** WorkStatus for one repo of a ticket (primary first). */
export interface RepoWork extends WorkStatus {
  repo: string;
}

export type WorkStage = "working" | "committed" | "draft" | "pr-open" | "merged" | "pr-closed" | "missing";

async function out(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1]}: ${(stderr || stdout).trim().slice(0, 200)}`);
  return stdout.trim();
}

export async function checkWork(worktreeId: string, repoPath: string, branch: string): Promise<WorkStatus> {
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
        status.missing ? repoPath : worktreePath),
    ) as WorkStatus["pr"][];
    status.pr = prs[0] ?? null;
  } catch (err) {
    errors.push((err as Error).message);
  }

  status.error = errors.length ? errors.join("; ") : null;
  return status;
}

/** Work that deleting this worktree would lose; empty when it's safe. A merged/closed PR is safe. */
export function atRisk(w: WorkStatus): string[] {
  if (w.missing) return [];
  if (w.dirtyFiles === null) return ["state couldn't be verified"];
  const risks: string[] = [];
  if (w.dirtyFiles) risks.push(`${w.dirtyFiles} uncommitted file${w.dirtyFiles === 1 ? "" : "s"}`);
  const settledPr = w.pr && w.pr.state !== "OPEN";
  if (w.unpushed && !settledPr) risks.push(`${w.unpushed} unpushed commit${w.unpushed === 1 ? "" : "s"}`);
  return risks;
}

export function stage(w: WorkStatus): WorkStage {
  if (w.pr?.state === "MERGED") return "merged";
  if (w.pr?.state === "CLOSED") return "pr-closed";
  if (w.pr) return w.pr.isDraft ? "draft" : "pr-open";
  if (w.missing) return "missing";
  return w.commitsAhead ? "committed" : "working";
}

const SETTLED: WorkStage[] = ["merged", "pr-closed", "missing"];
/** A repo the session never touched: no commits, no uncommitted files, no PR. */
const untouched = (w: WorkStatus) => !w.pr && !w.commitsAhead && !w.dirtyFiles;

/**
 * One stage for a whole ticket. Repos the agent never touched don't hold it back; the ticket
 * is settled once every touched repo's PR is merged or closed (or the worktrees are gone).
 */
export function overallStage(list: RepoWork[]): WorkStage {
  const touched = list.filter((w) => !untouched(w));
  if (touched.length === 0) return list.length && list.every((w) => w.missing) ? "missing" : "working";
  const stages = touched.map(stage);
  if (stages.every((s) => SETTLED.includes(s))) return stages.includes("merged") ? "merged" : stages[0];
  if (stages.includes("pr-open")) return "pr-open";
  if (stages.includes("draft")) return "draft";
  return stages.includes("committed") ? "committed" : "working";
}

/** True once the ticket's work is finished one way or another (shown under Recent). */
export const isSettled = (list: RepoWork[] | null) => !!list && SETTLED.includes(overallStage(list));

/** The fields that matter for display; a change in these is what bumps the item. */
export const workFingerprint = (list: RepoWork[]) =>
  JSON.stringify(list.map((w) => [w.repo, w.missing, w.commitsAhead, w.dirtyFiles, w.lastCommitAt, w.pr, w.error]));

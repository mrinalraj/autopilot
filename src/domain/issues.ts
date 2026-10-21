import { isSettled, overallStage, type RepoWork } from "./work";

export interface Explainer {
  summary: string;
  approach: string;
  likely_areas: string[];
  size: "S" | "M" | "L";
}

export interface TicketSnapshot {
  description: string | null;
  comments: { author: string; createdAt: string; body: string }[];
  team: string;
  project: string | null;
  labels: string[];
  attachments: { title: string; url: string }[];
  state: string;
  /** "Linear" or "Jira"; older rows predate Jira support. */
  tracker?: string;
}

/** A secondary repo the ticket also changes; it gets its own worktree on the same branch. */
export interface ExtraRepo {
  repo: string;
  repo_path: string;
  reason: string;
  worktree_id: string | null;
  /** Last adapter to adopt this worktree; imported branches may differ from the primary. */
  launcher?: string;
  branch?: string;
}

export type IssueStatus = "pending" | "approved" | "rejected" | "running" | "failed";

export interface IssueRow {
  linear_id: string;
  identifier: string;
  title: string;
  url: string;
  /** Rendered brief the Claude session reads; regenerated from this row. */
  brief_path: string;
  repo: string;
  repo_path: string;
  branch: string;
  confidence: number;
  resolve_reason: string;
  /** Null for imported summaries that have not gone through the LLM. */
  triage_source: "automatic" | "manual" | null;
  status: IssueStatus;
  error: string | null;
  worktree_id: string | null;
  /** Ticket snapshot (verbatim fields from Linear) and explainer, as JSON. */
  ticket_json: string;
  explainer_json: string;
  /** Live Linear workflow status (name and type) for launched and imported tickets. */
  linear_state: string | null;
  linear_state_type: string | null;
  /** Last adapter that successfully adopted the worktrees; never overrides Settings. */
  launcher: string | null;
  /** ExtraRepo[] as JSON; the primary repo is `repo`. */
  extra_repos_json: string;
  /** Latest RepoWork[] for a launched item, as JSON. */
  work_json: string | null;
  created_at: string;
  updated_at: string;
}

export type Phase = "in-progress" | "in-review" | "completed";

/**
 * Where a launched or imported ticket stands: completed when the tracker says done/canceled or every
 * touched repo's PR is merged/closed; in review when its status says review or a PR is open.
 */
export function phaseOf(row: IssueRow, work: RepoWork[] | null): Phase {
  if (["completed", "canceled", "duplicate"].includes(row.linear_state_type ?? "")) return "completed";
  if (isSettled(work)) return "completed";
  if (/review/i.test(row.linear_state ?? "")) return "in-review";
  if (work && overallStage(work) === "pr-open") return "in-review";
  return "in-progress";
}

export const issueExtras = (row: IssueRow): ExtraRepo[] => JSON.parse(row.extra_repos_json || "[]");
export const explainerOf = (row: IssueRow): Explainer => JSON.parse(row.explainer_json);
export const ticketOf = (row: IssueRow): TicketSnapshot => JSON.parse(row.ticket_json);
export const needsTriage = (row: IssueRow): boolean => row.status === "running" && row.triage_source === null;
export const usesLauncher = (row: IssueRow, name: string): boolean =>
  row.launcher === name && issueExtras(row).every((e) => !e.worktree_id || e.launcher === name);

/** Older rows stored one work result, before tickets could span multiple repos. */
export function workOf(row: IssueRow): RepoWork[] | null {
  if (!row.work_json) return null;
  const work = JSON.parse(row.work_json);
  return Array.isArray(work) ? work : [{ repo: row.repo, ...work }];
}

export function worktreesOf(row: IssueRow): { repo: string; repoPath: string; worktreeId: string; launcher?: string; branch?: string }[] {
  return [
    ...(row.worktree_id ? [{ repo: row.repo, repoPath: row.repo_path, worktreeId: row.worktree_id }] : []),
    ...issueExtras(row).flatMap((e) => e.worktree_id ? [{
      repo: e.repo, repoPath: e.repo_path, worktreeId: e.worktree_id,
      ...(e.launcher ? { launcher: e.launcher } : {}), ...(e.branch ? { branch: e.branch } : {}),
    }] : []),
  ];
}

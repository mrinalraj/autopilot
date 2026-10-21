import { esc } from "../escape";
import { issueExtras, type IssueRow, type IssueStatus } from "../../../domain/issues";
import type { RepoWork, WorkStage } from "../../../domain/work";

export const badge = (s: IssueStatus, error?: string | null) => {
  const label = s === "approved" ? "launching" : s === "rejected" && error?.startsWith("Dismissed:") ? "dismissed" : s;
  return `<span class="badge b-${s}">${label}</span>`;
};
export const modalId = (identifier: string) => `m-${identifier.replace(/[^A-Za-z0-9-]/g, "")}`;
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const STAGE_LABEL: Record<WorkStage, string> = {
  working: "in progress", committed: "committed", draft: "draft PR", "pr-open": "PR open",
  merged: "merged", "pr-closed": "PR closed", missing: "worktree gone",
};
export const stageBadge = (st: WorkStage) => `<span class="badge st-${st}">${STAGE_LABEL[st]}</span>`;

export const prState = (pr: NonNullable<RepoWork["pr"]>) => (pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : pr.state.toLowerCase());

/** Progress facts for a launched item: one line, or one line per repo when it spans several. */
export function workSummary(list: RepoWork[] | null): string {
  if (!list?.length) return `<div class="workline">Checking the worktree…</div>`;
  const multi = list.length > 1;
  const lines = list.map((w) => {
    const parts: string[] = [];
    if (multi) parts.push(`<span><b>${esc(w.repo)}</b></span>`);
    if (w.pr) parts.push(`<span><b>PR #${w.pr.number}</b> ${esc(prState(w.pr))}</span>`);
    if (w.missing) parts.push(`<span>worktree removed</span>`);
    else if (w.commitsAhead !== null) parts.push(`<span><b>${w.commitsAhead}</b> commit${w.commitsAhead === 1 ? "" : "s"}</span>`);
    if (w.dirtyFiles) parts.push(`<span><b>${w.dirtyFiles}</b> uncommitted</span>`);
    if (w.lastCommitAt) parts.push(`<span>last commit ${esc(ago(w.lastCommitAt))}</span>`);
    return `<div class="workline">${parts.join("")}</div>`;
  });
  return `${lines.join("")}<div class="workline"><span>checked ${esc(ago(list[0].checkedAt))}</span></div>`;
}

export const repoPills = (r: IssueRow) =>
  `<span class="pill">${esc(r.repo)}</span>${issueExtras(r).map((e) => `<span class="pill extra" title="${esc(e.reason)}">+ ${esc(e.repo)}</span>`).join("")}`;

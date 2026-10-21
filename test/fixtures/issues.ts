import type { IssueRow } from "../../src/domain/issues";
import type { RepoWork } from "../../src/domain/work";

export const issue = (patch: Partial<IssueRow> = {}): IssueRow => ({
  linear_id: "ticket-1", identifier: "ENG-1", title: "Fix widget", url: "https://example.test/ENG-1",
  brief_path: "/briefs/ENG-1.md", repo: "api", repo_path: "/code/api", branch: "fix-widget-eng-1",
  confidence: 0.8, resolve_reason: "API change", status: "pending", error: null,
  worktree_id: null, linear_state: "Todo", linear_state_type: "unstarted", launcher: "supacode",
  ticket_json: JSON.stringify({ description: "Widget details", comments: [], team: "Eng", project: null, labels: [], attachments: [], state: "Todo" }),
  explainer_json: JSON.stringify({ summary: "Fix widget", approach: "Update API", likely_areas: ["src/api.ts"], size: "S" }),
  extra_repos_json: "[]", work_json: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...patch,
});

export const work = (patch: Partial<RepoWork> = {}): RepoWork => ({
  repo: "api", checkedAt: "2026-01-01T00:00:00Z", worktreePath: "/work/api", missing: false,
  commitsAhead: 1, unpushed: 0, dirtyFiles: 0, lastCommitAt: null, pr: null, error: null,
  ...patch,
});

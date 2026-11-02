import {
  GitBranch,
  GitPullRequest,
  ListTodo,
  Search,
  Plus,
} from "lucide-react";
import { Issue, Plan, Snapshot } from "./types";
const lanes = [
  { id: "triage", label: "Triage", color: "var(--lane-triage, #9695a1)" },
  { id: "working", label: "Working", color: "var(--lane-working, #64a7f6)" },
  { id: "needs_you", label: "Needs you", color: "var(--lane-attention, #ffac64)" },
  { id: "in_review", label: "In review", color: "var(--lane-review, #e9cb56)" },
  { id: "done", label: "Done", color: "var(--lane-done, #62cb95)" },
];
export function FlowBoard({
  data,
  issues,
  query,
  setQuery,
  open,
  openPlan,
  create,
}: {
  data: Snapshot;
  issues: Issue[];
  query: string;
  setQuery: (v: string) => void;
  open: (i: Issue) => void;
  openPlan: (p: Plan) => void;
  create: () => void;
}) {
  return (
    <div className="flow-board">
      <div className="flow-toolbar">
        <strong>Issues</strong>
        <label className="search">
          <Search size={14} />
          <input
            id="search"
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="secondary" onClick={create}>
          <Plus size={14} />
          New issue
        </button>
      </div>
      <div className="flow-lanes" aria-label="Issue board">
        {lanes.map((lane) => (
          <section
            className="flow-lane"
            key={lane.id}
            aria-label={lane.label}
            style={{ "--lane-color": lane.color } as React.CSSProperties}
          >
            <header>
              <i />
              {lane.label}
              <span>
                {
                  issues.filter(
                    (i) => (i.workflowState || "triage") === lane.id,
                  ).length
                }
              </span>
            </header>
            <div className="flow-cards">
              {issues
                .filter((i) => (i.workflowState || "triage") === lane.id)
                .map((issue) => {
                  const plans = data.plans.filter((p) =>
                    issue.planIds?.includes(p.id),
                  );
                  const executions = data.executions.filter((e) =>
                    plans.some((p) => p.id === e.planId),
                  );
                  const runs = data.runs.filter(
                    (r) =>
                      r.task.issueId === issue.id ||
                      executions.some((e) => e.id === r.executionId),
                  );
                  const changes = data.changes.filter((c) =>
                    runs.some((r) => r.id === c.runId),
                  );
                  const branch = runs.flatMap((r) => r.worktrees)[0]?.branch;
                  return (
                    <article className="flow-card" key={issue.id}>
                      <button
                        className="flow-card-title"
                        onClick={() => open(issue)}
                      >
                        <span className="identifier">{issue.identifier}</span>
                        <h3>{issue.title}</h3>
                      </button>
                      {branch && (
                        <p className="flow-branch" title={branch}>
                          <GitBranch size={12} />
                          {branch}
                        </p>
                      )}
                      <div className="flow-card-status">
                        <i />
                        {issue.workflowDetail || "Waiting for coordinator"}
                      </div>
                      {plans.map((p) => (
                        <button
                          className="flow-plan"
                          key={p.id}
                          onClick={() => openPlan(p)}
                        >
                          <ListTodo size={12} />
                          {p.state === "draft" ? "Review plan" : "View plan"}
                        </button>
                      ))}
                      {changes.map((c) => (
                        <a
                          className="flow-change"
                          href={c.url}
                          key={c.id}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <GitPullRequest size={12} />#{c.number} {c.state} ·{" "}
                          {c.checks}
                        </a>
                      ))}
                    </article>
                  );
                })}
              {!issues.some(
                (i) => (i.workflowState || "triage") === lane.id,
              ) && <span className="flow-empty">No issues</span>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

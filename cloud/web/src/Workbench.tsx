import { lazy, Suspense, useEffect, useState, useRef } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { api } from "./api";
import {
  Event,
  isLive,
  Issue,
  Plugin,
  Repository,
  Run,
  Session,
  Worktree,
} from "./types";
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);
export function worktreeState(w: Worktree, sessions: Session[], runs: Run[]) {
  if (w.status !== "present")
    return { label: w.status, icon: AlertCircle, tone: "attention" };
  const own = sessions
    .filter((s) => s.worktreeId === w.id || s.worktreeIds?.includes(w.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = own.filter(isLive);
  if (active.some((s) => s.state === "needs_input"))
    return { label: "Needs attention", icon: AlertCircle, tone: "attention" };
  if (active.some((s) => s.kind !== "shell" && s.state !== "idle"))
    return { label: "Running", icon: LoaderCircle, tone: "running" };
  if (active.some((s) => s.kind !== "shell"))
    return { label: "Waiting", icon: Circle, tone: "waiting" };
  const latest = runs
    .filter((r) => r.worktrees.some((t) => t.path === w.path))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (
    latest &&
    (!own[0] ||
      latest.createdAt >= own[0].createdAt ||
      latest.sessionId === own[0].id)
  ) {
    if (latest.state === "completed")
      return { label: "Finished", icon: Check, tone: "finished" };
    if (latest.state === "failed")
      return { label: "Failed", icon: AlertCircle, tone: "attention" };
  }
  if (
    own[0]?.state === "resume_required" ||
    (own[0]?.state === "exited" && own[0]?.kind !== "shell")
  )
    return { label: "Review session", icon: AlertCircle, tone: "attention" };
  if (active.length)
    return { label: "Terminal open", icon: TerminalSquare, tone: "neutral" };
  return {
    label: own.length ? "Stopped" : "No agent",
    icon: GitBranch,
    tone: "neutral",
  };
}
export function RepositoryTree({
  repos,
  worktrees,
  sessions,
  runs,
  selected,
  select,
  create,
  add,
  manage,
  refresh,
  busy,
}: {
  repos: Repository[];
  worktrees: Worktree[];
  sessions: Session[];
  runs: Run[];
  selected: string;
  select: (id: string) => void;
  create: (r: Repository) => void;
  add: () => void;
  manage: () => void;
  refresh: (r: Repository, fetch: boolean) => void;
  busy: boolean;
}) {
  const [closed, setClosed] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("autopilot.closedRepositories") || "[]",
      );
    } catch {
      return [];
    }
  });
  const toggle = (id: string) => {
    const next = closed.includes(id)
      ? closed.filter((x) => x !== id)
      : [...closed, id];
    setClosed(next);
    localStorage.setItem("autopilot.closedRepositories", JSON.stringify(next));
  };
  return (
    <div
      className="repository-tree"
      onKeyDown={(e) => {
        if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
        const buttons = [
          ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ].filter((b) => b.getClientRects().length);
        const n = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (n >= 0) {
          e.preventDefault();
          buttons[
            (n + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}
    >
      <div className="tree-label">
        <span>REPOSITORIES</span>
        <button
          title="Add repository"
          aria-label="Add repository"
          onClick={add}
        >
          <Plus size={15} />
        </button>
      </div>
      {!repos.length && (
        <p className="tree-empty">Add a repository to browse its worktrees.</p>
      )}
      {repos.map((r) => (
        <section className="repo-tree-group" key={r.id} aria-label={r.name}>
          <div className="repo-tree-heading">
            <button
              aria-expanded={!closed.includes(r.id)}
              onClick={() => toggle(r.id)}
              title={r.path}
            >
              {closed.includes(r.id) ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
              <FolderGit2 size={15} />
              <span>{r.name}</span>
            </button>
            <button
              aria-label={`New worktree in ${r.name}`}
              title="New worktree"
              onClick={() => create(r)}
            >
              <Plus size={14} />
            </button>
            <details className="repo-menu">
              <summary aria-label={`Actions for ${r.name}`}>
                <MoreHorizontal size={15} />
              </summary>
              <div>
                <button disabled={busy} onClick={() => refresh(r, false)}>
                  Rescan worktrees
                </button>
                <button disabled={busy} onClick={() => refresh(r, true)}>
                  Fetch branches
                </button>
                <button onClick={manage}>Repository settings</button>
              </div>
            </details>
          </div>
          {!closed.includes(r.id) && (
            <div className="worktree-children">
              {worktrees
                .filter((w) => w.repositoryId === r.id && !w.hidden)
                .sort(
                  (a, b) =>
                    Number(b.primary) - Number(a.primary) ||
                    a.name.localeCompare(b.name),
                )
                .map((w) => {
                  const state = worktreeState(w, sessions, runs);
                  return (
                    <button
                      key={w.id}
                      className={`worktree-nav ${selected === w.id ? "active" : ""}`}
                      aria-current={selected === w.id ? "page" : undefined}
                      title={`${w.path}\n${w.branch || "Detached HEAD"} · ${state.label}`}
                      onClick={() => select(w.id)}
                    >
                      <state.icon size={13} className={`state-${state.tone}`} />
                      <span>
                        {w.primary
                          ? `(default) ${w.branch || "detached"}`
                          : w.name}
                      </span>
                      <span className="sr-only"> · {state.label}</span>
                    </button>
                  );
                })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
export function NewWorktreeForm({
  repo,
  issues,
  busy,
  save,
}: {
  repo: Repository;
  issues: Issue[];
  busy: boolean;
  save: (value: unknown, key: string) => void;
}) {
  const [name, setName] = useState(""),
    [branch, setBranch] = useState(""),
    [base, setBase] = useState(""),
    [issueId, setIssue] = useState(""),
    [branches, setBranches] = useState<string[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  useEffect(
    () => setRequestKey(crypto.randomUUID()),
    [name, branch, base, issueId],
  );
  const load = async (fetch = false) => {
    setLoading(true);
    setError("");
    try {
      const list = await api<string[]>(
        `/repositories/${repo.id}/${fetch ? "fetch" : "branches"}`,
        fetch ? {} : undefined,
      );
      setBranches(list);
      setBase((current) =>
        list.includes(current)
          ? current
          : list.find(
              (b) => b === `refs/remotes/origin/${repo.defaultBranch}`,
            ) ||
            list.find((b) => b === `refs/heads/${repo.defaultBranch}`) ||
            list[0] ||
            "",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [repo.id]);
  return (
    <form
      className="workbench-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({ name, branch, base, issueId }, requestKey);
      }}
    >
      <p className="muted">
        Create an isolated checkout of <strong>{repo.name}</strong>. Start a
        terminal or agent whenever you're ready.
      </p>
      <label>
        Worktree name
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => {
            const value = e.target.value;
            const slug = (s: string) =>
              s
                .toLowerCase()
                .replace(/[^a-z0-9/_-]+/g, "-")
                .replace(/^-|-$/g, "");
            if (!branch || branch === slug(name)) setBranch(slug(value));
            setName(value);
          }}
          placeholder="fix-checkout"
        />
      </label>
      <label>
        New branch
        <input
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="fix-checkout"
        />
      </label>
      <label>
        Base branch
        <input
          required
          list="worktree-base-branches"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="Search local and remote branches"
        />
        <datalist id="worktree-base-branches">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </label>
      <button
        className="secondary"
        type="button"
        disabled={loading || busy}
        onClick={() => void load(true)}
      >
        <RefreshCw size={14} /> Fetch branches
      </button>
      <label>
        Linked issue <small>Optional</small>
        <select value={issueId} onChange={(e) => setIssue(e.target.value)}>
          <option value="">No issue</option>
          {issues.map((i) => (
            <option value={i.id} key={i.id}>
              {i.identifier} · {i.title}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Stored in Autopilot's managed worktree directory, outside your source
        checkout. Your base branch stays unchanged.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!loading && !branches.length && !error && (
        <p className="inline-error">
          No branches with commits found. Create an initial commit in the
          repository first.
        </p>
      )}
      <div className="form-footer">
        <button
          className="primary"
          disabled={busy || loading || !branches.includes(base)}
        >
          Create worktree
        </button>
      </div>
    </form>
  );
}
export function StartAgentForm({
  plugins,
  defaultHarness,
  busy,
  save,
}: {
  plugins: Plugin[];
  defaultHarness: string;
  busy: boolean;
  save: (harness: string, prompt: string) => void;
}) {
  const [harness, setHarness] = useState(defaultHarness),
    [prompt, setPrompt] = useState("");
  return (
    <form
      className="workbench-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(harness, prompt);
      }}
    >
      <label>
        Agent harness
        <select value={harness} onChange={(e) => setHarness(e.target.value)}>
          {plugins
            .filter((p) => p.type === "agent")
            .map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {!p.available ? " · unavailable" : ""}
              </option>
            ))}
        </select>
      </label>
      <label>
        Task
        <textarea
          autoFocus
          required
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent work on?"
        />
      </label>
      <p className="muted">
        Starts in this worktree using your configured harness. No plan is
        required for manual work.
      </p>
      <div className="form-footer">
        <button className="primary" disabled={busy || !prompt.trim()}>
          Start agent
        </button>
      </div>
    </form>
  );
}
export function WorktreeView({
  worktree: w,
  sessions,
  runs,
  events,
  csrf,
  busy,
  launch,
  sessionAction,
  runDetails,
  plugins,
  worktreeAction,
}: {
  worktree: Worktree;
  sessions: Session[];
  runs: Run[];
  events: Event[];
  csrf: string;
  busy: boolean;
  plugins: Plugin[];
  launch: (kind: "shell" | "agent", harness?: string) => void;
  sessionAction: (id: string, action: string) => void;
  runDetails: React.ReactNode;
  worktreeAction: (action: string) => void;
}) {
  const own = sessions
    .filter((s) => s.worktreeId === w.id || s.worktreeIds?.includes(w.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [selected, setSelected] = useState(
      () => localStorage.getItem(`autopilot.terminal.${w.id}`) || "",
    ),
    [panel, setPanel] = useState(""),
    [changes, setChanges] = useState<{ status: string; diff: string }>(),
    [error, setError] = useState("");
  const [review, setReview] = useState<{
      change: {
        state: string;
        url: string;
        title: string;
        checks: string;
        feedback: { id: string; body: string }[];
      };
      mergeability: string;
      comments: { id: string; body: string }[];
    }>(),
    [reviewError, setReviewError] = useState(""),
    [reviewBusy, setReviewBusy] = useState(false);
  const previous = useRef(own.length);
  useEffect(() => {
    if (own.length > previous.current) setSelected(own.at(-1)!.id);
    previous.current = own.length;
  }, [own.length]);
  const session =
    own.find((s) => s.id === selected) ||
    own.filter(isLive).at(-1) ||
    own.at(-1);
  useEffect(() => {
    if (session) localStorage.setItem(`autopilot.terminal.${w.id}`, session.id);
  }, [session?.id, w.id]);
  const load = () => {
    setError("");
    api<{ status: string; diff: string }>(`/worktrees/${w.id}/changes`)
      .then(setChanges)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    if (panel === "changes") load();
  }, [panel, w.id]);
  const ids = new Set([
    w.id,
    ...own.map((s) => s.id),
    ...runs
      .filter((r) => r.worktrees.some((t) => t.path === w.path))
      .map((r) => r.id),
  ]);
  return (
    <div className="terminal-workspace">
      <div className="compact-session-tabs">
        <div className="session-tab-list">
          {own.map((s, n) => (
            <button
              key={s.id}
              className={session?.id === s.id ? "active" : ""}
              onClick={() => setSelected(s.id)}
            >
              <TerminalSquare size={13} />
              {s.kind === "shell" ? `Terminal ${n + 1}` : s.harness.label}
              <span
                className={`session-indicator ${isLive(s) ? "live" : ""}`}
              />
            </button>
          ))}
        </div>
        <div className="terminal-tab-actions">
          {session && isLive(session) && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => sessionAction(session.id, "stop")}
            >
              Stop
            </button>
          )}
          <button
            className={panel === "changes" ? "active" : ""}
            onClick={() => setPanel(panel === "changes" ? "" : "changes")}
            aria-label="Toggle changes sidebar"
          >
            <GitBranch size={15} />
          </button>
          <button
            className={panel === "activity" ? "active" : ""}
            onClick={() => setPanel(panel === "activity" ? "" : "activity")}
            aria-label="Toggle activity sidebar"
          >
            <MoreHorizontal size={17} />
          </button>
        </div>
      </div>
      <div className="terminal-workspace-body">
        <div className="terminal-stage">
          {session && isLive(session) ? (
            <Suspense fallback={<p>Opening terminal…</p>}>
              <Terminal key={session.id} id={session.id} csrf={csrf} />
            </Suspense>
          ) : (
            <div className="quiet-terminal-empty">
              <TerminalSquare size={22} />
              <p>
                {session
                  ? "Session stopped. Open a terminal or agent below."
                  : "Choose a terminal or agent below."}
              </p>
              {session?.error && (
                <p className="inline-error">{session.error}</p>
              )}
              {session &&
                session.kind !== "shell" &&
                session.conversationId && (
                  <button
                    className="secondary"
                    onClick={() => sessionAction(session.id, "resume")}
                  >
                    Resume conversation
                  </button>
                )}
            </div>
          )}
        </div>
        {panel && (
          <aside className="worktree-inspector">
            <div className="inspector-tabs">
              <button
                className={panel === "changes" ? "active" : ""}
                onClick={() => setPanel("changes")}
              >
                Changes
              </button>
              <button
                className={panel === "activity" ? "active" : ""}
                onClick={() => setPanel("activity")}
              >
                Activity
              </button>
              <button onClick={() => setPanel("")} aria-label="Close sidebar">
                ×
              </button>
            </div>
            <div className="inspector-content">
              {panel === "changes" ? (
                <>
                  <div className="pane-title">
                    <h3>Working changes</h3>
                    <button onClick={load} aria-label="Refresh changes">
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  {error ? (
                    <p className="inline-error">{error}</p>
                  ) : (
                    <>
                      <pre className="code-output">
                        {changes
                          ? changes.status || "Working tree is clean."
                          : "Loading…"}
                      </pre>
                      {changes?.diff && (
                        <pre className="code-output">{changes.diff}</pre>
                      )}
                    </>
                  )}
                  <div className="pane-title">
                    <h3>Pull request</h3>
                    <button
                      disabled={reviewBusy}
                      onClick={async () => {
                        setReviewBusy(true);
                        setReviewError("");
                        try {
                          setReview(await api(`/worktrees/${w.id}/review`));
                        } catch (e) {
                          setReviewError((e as Error).message);
                        } finally {
                          setReviewBusy(false);
                        }
                      }}
                    >
                      {reviewBusy ? "Checking…" : "Refresh"}
                    </button>
                  </div>
                  {reviewError && <p className="inline-error">{reviewError}</p>}
                  {review &&
                    (review.change.state === "missing" ? (
                      <p>No change request for this branch.</p>
                    ) : (
                      <>
                        <a
                          href={review.change.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {review.change.title}
                        </a>
                        <p>
                          {review.change.state} · CI: {review.change.checks} ·{" "}
                          {review.mergeability}
                        </p>
                        {[...review.comments, ...review.change.feedback]
                          .filter(
                            (v, n, all) =>
                              all.findIndex((x) => x.id === v.id) === n,
                          )
                          .map((c) => (
                            <p className="review-comment" key={c.id}>
                              {c.body}
                            </p>
                          ))}
                      </>
                    ))}
                </>
              ) : (
                <>
                  {runDetails}
                  {events
                    .filter((e) => ids.has(e.entityId))
                    .slice(-50)
                    .reverse()
                    .map((e) => (
                      <div className="event" key={e.sequence}>
                        <span>{e.message || e.kind}</span>
                        <time>{new Date(e.at).toLocaleTimeString()}</time>
                      </div>
                    ))}
                  <details className="worktree-maintenance">
                    <summary>Worktree settings</summary>
                    <p className="mono">{w.path}</p>
                    <button onClick={() => worktreeAction("pin")}>
                      {w.pinned ? "Unpin" : "Pin"}
                    </button>
                    {!w.primary && (
                      <>
                        <button onClick={() => worktreeAction("unregister")}>
                          Hide from sidebar
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                "Remove this worktree? Dirty or unpushed work blocks removal.",
                              )
                            )
                              worktreeAction("remove");
                          }}
                        >
                          Remove worktree
                        </button>
                      </>
                    )}
                  </details>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      <div className="launch-dock" aria-label="Launch in this worktree">
        <button
          disabled={busy || w.status !== "present"}
          onClick={() => launch("shell")}
        >
          <TerminalSquare size={14} />
          Terminal
        </button>
        {plugins
          .filter((p) => p.type === "agent")
          .map((p) => (
            <button
              key={p.id}
              disabled={busy || !p.available || w.status !== "present"}
              title={p.reason || `Open ${p.label} in this worktree`}
              onClick={() => launch("agent", p.id)}
            >
              <span
                aria-hidden="true"
                className={`harness-mark harness-${p.id}`}
              >
                ✳
              </span>
              {p.label}
            </button>
          ))}
      </div>
    </div>
  );
}

export function CoordinatorView({
  session,
  csrf,
  busy,
  start,
  action,
}: {
  session?: Session;
  csrf: string;
  busy: boolean;
  start: () => void;
  action: (id: string, a: string) => void;
}) {
  return (
    <div className="terminal-workspace coordinator-screen">
      <div className="compact-session-tabs">
        <div className="session-tab-list">
          <span className="coordinator-tab">
            <TerminalSquare size={14} />
            Coordinator
            {session && (
              <span
                className={`session-indicator ${isLive(session) ? "live" : ""}`}
              />
            )}
          </span>
        </div>
        {session && isLive(session) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => action(session.id, "stop")}
          >
            Stop
          </button>
        )}
      </div>
      <div className="terminal-stage">
        {session && isLive(session) ? (
          <Suspense fallback={<p>Opening coordinator…</p>}>
            <Terminal key={session.id} id={session.id} csrf={csrf} />
          </Suspense>
        ) : (
          <div className="quiet-terminal-empty">
            <p>
              {session?.error ||
                "The coordinator plans incoming tickets for this workspace."}
            </p>
            <button className="secondary" disabled={busy} onClick={start}>
              {session ? "Restart coordinator" : "Start coordinator"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

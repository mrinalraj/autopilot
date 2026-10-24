import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  CircleHelp,
  Command,
  FolderGit2,
  FolderInput,
  GitBranch,
  GitPullRequest,
  Inbox,
  Layers,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  MoreHorizontal,
  Menu,
  Plus,
  Search,
  Settings2,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api, setCSRF } from "./api";
import {
  Action,
  Change,
  columns,
  Event,
  Integration,
  isLive,
  Issue,
  Plan,
  Plugin,
  priorities,
  Project,
  Repository,
  Run,
  Session,
  Snapshot,
  Task,
  Workspace,
  Worktree,
} from "./types";
const Terminal = lazy(() =>
  import("./Terminal").then((module) => ({ default: module.Terminal })),
);
import "./styles.css";
import {
  RepositoryTree,
  NewWorktreeForm,
  StartAgentForm,
  WorktreeView,
  CoordinatorView,
} from "./Workbench";
import {
  SettingsNavigation,
  PluginCatalog,
  GeneralSettings,
  ConnectionTools,
  pluginNames,
} from "./PluginSettings";
import "./workbench.css";
import { FlowBoard } from "./FlowBoard";
import "./terminal-workspace.css";

type Page =
  | "coordinator"
  | "worktree"
  | "settings"
  | "issues"
  | "plans"
  | "sessions"
  | "workspace"
  | "integrations"
  | "attention";
type Modal =
  | { kind: "newWorktree"; repo: Repository }
  | { kind: "startAgent"; worktree: Worktree }
  | { kind: "workspace" }
  | { kind: "importWorkspace" }
  | { kind: "removeWorkspace"; workspace: Workspace }
  | { kind: "repository" }
  | { kind: "project" }
  | { kind: "issue"; issue?: Issue; status?: string }
  | { kind: "plan"; issue?: Issue; plan?: Plan }
  | { kind: "session"; id: string }
  | { kind: "integration"; integration?: Integration; provider?: string }
  | null;

function App() {
  const [data, setData] = useState<Snapshot>();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [workspaceID, setWorkspaceID] = useState(
    localStorage.getItem("autopilot.workspace") || "",
  );
  const [page, setPage] = useState<Page>("issues");
  const [worktreeID, setWorktreeID] = useState(
    localStorage.getItem("autopilot.worktree") || "",
  );
  const [settingsSection, setSettingsSection] = useState("general");
  const [mobileNav, setMobileNav] = useState(false);
  const [queueOnly, setQueueOnly] = useState(false);
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCanceled, setShowCanceled] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api<Snapshot>("/snapshot");
    setCSRF(next.csrf);
    setData(next);
    setWorkspaceID((current) =>
      next.workspaces.some((w) => w.id === current)
        ? current
        : next.workspaces[0]?.id || "",
    );
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api<Plugin[]>("/plugins")
      .then(setPlugins)
      .catch((e) => setError(e.message));
    const es = new EventSource("/api/v1/events");
    let timer: number;
    es.onmessage = (e) => {
      const event = JSON.parse(e.data) as Event;
      setEvents((old) => [...old.slice(-99), event]);
      clearTimeout(timer);
      timer = window.setTimeout(() => refresh().catch(() => {}), 250);
    };
    es.onerror = () => {};
    return () => {
      es.close();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    localStorage.setItem("autopilot.workspace", workspaceID);
    setProject("");
  }, [workspaceID]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.matches("input,textarea,select") ||
        target.isContentEditable ||
        modal
      )
        return;
      if (e.key === "c" && workspaceID) {
        e.preventDefault();
        setModal({ kind: "issue" });
      }
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [workspaceID, modal]);
  const act = async (fn: () => Promise<unknown>, message = "Saved") => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      setNotice(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <div className="loading">
        <div className="brand-symbol">
          <Zap size={22} />
        </div>
        <p>{error || "Opening your workspace…"}</p>
        {error && (
          <button onClick={() => refresh().catch((e) => setError(e.message))}>
            Try again
          </button>
        )}
      </div>
    );
  const workspace = data.workspaces.find((w) => w.id === workspaceID);
  const worktrees = (data.worktrees || []).filter(
    (w) => w.workspaceId === workspaceID,
  );
  const selectedWorktree =
    worktrees.find((w) => w.id === worktreeID && !w.hidden) ||
    worktrees.find((w) => !w.hidden);
  const selectWorktree = (id: string) => {
    setWorktreeID(id);
    localStorage.setItem("autopilot.worktree", id);
    setPage("worktree");
    setMobileNav(false);
  };
  const settingsPage = [
    "settings",
    "workspace",
    "integrations",
    "attention",
  ].includes(page);
  const chooseSettings = (section: string) => {
    setSettingsSection(section);
    setPage(
      section === "workspace"
        ? "workspace"
        : section === "plugins"
          ? "integrations"
          : section === "activity"
            ? "attention"
            : "settings",
    );
    setMobileNav(false);
  };
  const selectedConnection = data.integrations.find(
    (i) => i.id === settingsSection && i.workspaceId === workspaceID,
  );
  const queue = (data.queue || []).filter(
    (e) => e.workspaceId === workspaceID && e.state === "pending",
  );
  const repos = data.repositories.filter((r) => r.workspaceId === workspaceID),
    projects = data.projects.filter((p) => p.workspaceId === workspaceID);
  const issues = data.issues.filter(
    (i) =>
      i.workspaceId === workspaceID &&
      i.workflowState !== "untracked" &&
      (!project || i.projectId === project) &&
      (!queueOnly || queue.some((e) => e.issueId === i.id)) &&
      `${i.title} ${i.identifier} ${i.labels?.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const plans = data.plans.filter((p) => p.workspaceId === workspaceID),
    runs = data.runs.filter((r) => r.workspaceId === workspaceID),
    sessions = data.sessions.filter((s) => s.workspaceId === workspaceID),
    integrations = data.integrations.filter(
      (i) => i.workspaceId === workspaceID,
    );
  const actions = data.actions.filter(
    (a) =>
      !["delivered", "dismissed"].includes(a.state) &&
      (sessions.some((s) => s.id === a.entityId) ||
        runs.some((r) => r.id === a.entityId) ||
        data.issues.some(
          (i) => i.id === a.entityId && i.workspaceId === workspaceID,
        )),
  );
  const attentionSessions = sessions.filter((s) =>
    ["needs_input", "resume_required", "exited"].includes(s.state),
  );
  const attentionCount =
    actions.length +
    attentionSessions.length +
    runs.filter((r) => r.state === "failed").length +
    plans.filter((p) => p.state === "draft").length;
  const nav = [
    { id: "issues" as Page, label: "Issues", icon: LayoutDashboard },
    { id: "plans" as Page, label: "Plans", icon: ListTodo },
  ];
  const coordinator = sessions
    .filter((s) => s.role === "orchestrator")
    .sort(
      (a, b) =>
        Number(isLive(b)) - Number(isLive(a)) ||
        b.createdAt.localeCompare(a.createdAt),
    )[0];
  const selectedRepo = repos.find(
    (r) => r.id === selectedWorktree?.repositoryId,
  );
  const branchChange = data.changes.find((c) =>
    runs.some(
      (r) =>
        r.id === c.runId &&
        r.worktrees.some((w) => w.path === selectedWorktree?.path),
    ),
  );
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "drawer-open" : ""}`}>
        <div className="brand">
          <span className="brand-symbol">
            <Zap size={18} />
          </span>
          <strong>autopilot</strong>
          <span className="edition">CLOUD</span>
        </div>
        <div className="workspace-select">
          <select
            aria-label="Active workspace"
            value={workspaceID}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "@import") setModal({ kind: "importWorkspace" });
              else if (value === "@manage") chooseSettings("workspace");
              else if (value === "@create") setModal({ kind: "workspace" });
              else {
                setWorkspaceID(value);
                setMobileNav(false);
              }
            }}
          >
            {!workspace && <option value="">Choose a workspace</option>}
            {data.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option disabled>──────────</option>
            <option value="@create">Create workspace…</option>
            <option value="@import">Import workspace…</option>
            <option value="@manage">Workspace settings…</option>
          </select>
          <ChevronDown size={14} />
          <button
            title="Create workspace"
            aria-label="Create workspace"
            onClick={() => setModal({ kind: "workspace" })}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav active" : "nav"}
              onClick={() => {
                setPage(n.id);
                setMobileNav(false);
              }}
            >
              <n.icon size={17} />
              {n.label}
              {n.id === "attention" && attentionCount > 0 && (
                <span className="count">{attentionCount}</span>
              )}
            </button>
          ))}
        </nav>
        <RepositoryTree
          repos={repos}
          worktrees={worktrees}
          sessions={sessions}
          runs={runs}
          selected={page === "worktree" ? selectedWorktree?.id || "" : ""}
          select={selectWorktree}
          create={(repo) => setModal({ kind: "newWorktree", repo })}
          add={() => setModal({ kind: "repository" })}
          manage={() => chooseSettings("workspace")}
          busy={busy}
          refresh={(repo, fetch) =>
            void act(
              () =>
                api(`/repositories/${repo.id}/${fetch ? "fetch" : "scan"}`, {}),
              fetch ? "Branches fetched" : "Worktrees refreshed",
            )
          }
        />
        <button
          className={`nav coordinator-link ${page === "coordinator" ? "active" : ""}`}
          onClick={() => {
            setPage("coordinator");
            setMobileNav(false);
            if (!coordinator || !isLive(coordinator))
              void act(
                () => api(`/workspaces/${workspaceID}/orchestrator`, {}),
                "Coordinator opened",
              );
          }}
        >
          <Zap size={15} />
          Coordinator
          {coordinator && (
            <span
              className={`session-indicator ${isLive(coordinator) ? "live" : ""}`}
            />
          )}
        </button>
        <div className="sidebar-bottom">
          <button
            className={"nav " + (settingsPage ? "active" : "")}
            onClick={() => chooseSettings("general")}
          >
            <Settings2 size={17} />
            Settings
            {integrations.some((i) => i.error) && (
              <span className="connection-dot error" />
            )}
          </button>
          <div className="host-status">
            <span className="dot online" />
            Personal cloud<span>v0.1</span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="mobile-nav-toggle"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{workspace?.name || "Autopilot"}</span>
            <span className="slash">/</span>
            <strong>
              {projects.find((p) => p.id === project)?.name ||
                {
                  coordinator: "Coordinator",
                  worktree: selectedRepo?.name || "Worktrees",
                  settings: "Settings",
                  issues: "Issues",
                  plans: "Plans",
                  sessions: "Agent sessions",
                  workspace: "Workspace",
                  integrations: "Plugins",
                  attention: "Needs attention",
                }[page]}
            </strong>
            {page === "worktree" && selectedWorktree && (
              <span
                className={`header-branch pr-${branchChange?.state || "none"}`}
                title={
                  branchChange
                    ? `PR #${branchChange.number}: ${branchChange.state}`
                    : selectedWorktree.path
                }
              >
                {branchChange ? (
                  <GitPullRequest size={14} />
                ) : (
                  <GitBranch size={14} />
                )}{" "}
                {selectedWorktree.branch || selectedWorktree.head.slice(0, 10)}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="Open workspace settings"
              onClick={() => setPage("workspace")}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </header>
        {error && !modal && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={15} />
            {notice}
          </div>
        )}
        <div
          className={
            settingsPage && workspace ? "settings-layout" : "page-layout"
          }
        >
          {settingsPage && workspace && (
            <SettingsNavigation
              section={
                page === "workspace"
                  ? "workspace"
                  : page === "integrations"
                    ? "plugins"
                    : page === "attention"
                      ? "activity"
                      : settingsSection
              }
              connections={integrations}
              choose={chooseSettings}
            />
          )}
          <div className="page-body">
            {!workspace ? (
              <div className="welcome">
                <div className="welcome-mark">
                  <Layers size={34} />
                </div>
                <div className="eyebrow">YOUR NEXT CHAPTER</div>
                <h1>
                  A workspace for work
                  <br />
                  that moves itself forward.
                </h1>
                <p>
                  Bring your repositories, plan the work, and give your agents a
                  place to build.
                </p>
                <div className="welcome-actions">
                  <button
                    className="primary"
                    onClick={() => setModal({ kind: "workspace" })}
                  >
                    <Plus size={16} />
                    Create your workspace
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setModal({ kind: "importWorkspace" })}
                  >
                    <FolderInput size={16} /> Import existing workspace
                  </button>
                </div>
                <div className="welcome-foot">
                  Your server. Your repositories. Your choice of agent.
                </div>
              </div>
            ) : (
              <>
                {page === "issues" && (
                  <FlowBoard
                    data={data}
                    issues={issues}
                    query={query}
                    setQuery={setQuery}
                    open={(issue) => setModal({ kind: "issue", issue })}
                    openPlan={(plan) => setModal({ kind: "plan", plan })}
                    create={() => setModal({ kind: "issue" })}
                  />
                )}
                {page === "coordinator" && (
                  <CoordinatorView
                    session={coordinator}
                    csrf={data.csrf}
                    busy={busy}
                    start={() =>
                      void act(
                        () =>
                          api(`/workspaces/${workspaceID}/orchestrator`, {}),
                        "Coordinator opened",
                      )
                    }
                    action={(id, action) =>
                      void act(
                        () => api(`/sessions/${id}/${action}`, {}),
                        "Coordinator updated",
                      )
                    }
                  />
                )}
                {page === "plans" && (
                  <div className="page-content">
                    <PageHeading
                      eyebrow="HUMAN APPROVAL, AGENT EXECUTION"
                      title="Plans"
                      description="Review the scope once. Let the orchestrator coordinate the work."
                      action={
                        <button
                          className="primary"
                          onClick={() => setModal({ kind: "plan" })}
                        >
                          <Plus size={16} />
                          New plan
                        </button>
                      }
                    />
                    {plans.length === 0 ? (
                      <Empty
                        icon={<ListTodo />}
                        title="Good work starts with a plan"
                        text="Start an orchestrator to propose work, or create a plan yourself."
                        action={
                          <button
                            className="secondary"
                            disabled={busy || !repos.length}
                            onClick={() =>
                              void act(
                                () =>
                                  api(
                                    "/workspaces/" +
                                      workspaceID +
                                      "/orchestrator",
                                    {},
                                  ),
                                "Orchestrator started",
                              )
                            }
                          >
                            Start orchestrator
                          </button>
                        }
                      />
                    ) : (
                      plans.map((plan) => (
                        <div className="surface plan-row" key={plan.id}>
                          <div className="row-icon">
                            <ListTodo size={19} />
                          </div>
                          <div className="grow">
                            <button
                              className="text-button"
                              onClick={() => setModal({ kind: "plan", plan })}
                            >
                              {plan.title}
                            </button>
                            <p>
                              {plan.summary ||
                                `${plan.tasks.length} tasks · revision ${plan.revision}`}
                            </p>
                            <div className="tag-row">
                              {plan.tasks.map((t) => (
                                <span className="tag" key={t.id}>
                                  {t.title}
                                </span>
                              ))}
                            </div>
                          </div>
                          <span
                            className={
                              "badge " +
                              (plan.state === "draft" ? "amber" : "green")
                            }
                          >
                            {plan.state === "draft"
                              ? "Awaiting approval"
                              : "Approved"}
                          </span>
                          <button
                            className="secondary"
                            onClick={() => setModal({ kind: "plan", plan })}
                          >
                            Review plan
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
                {page === "sessions" && (
                  <div className="page-content">
                    <PageHeading
                      eyebrow="YOUR AGENT TEAM"
                      title="Agent sessions"
                      description="Independent terminals. One place to keep track."
                      action={
                        <button
                          className="primary"
                          disabled={busy || !repos.length}
                          onClick={() =>
                            void act(
                              () =>
                                api(
                                  "/workspaces/" +
                                    workspaceID +
                                    "/orchestrator",
                                  {},
                                ),
                              "Orchestrator started",
                            )
                          }
                        >
                          <Zap size={16} />
                          Start orchestrator
                        </button>
                      }
                    />
                    <SessionList
                      sessions={sessions}
                      open={(id) => setModal({ kind: "session", id })}
                    />
                    <h2 className="section-title">
                      Worker runs <span>{runs.length}</span>
                    </h2>
                    {!runs.length && (
                      <p className="muted">
                        Approve a plan to put work in the queue.
                      </p>
                    )}
                    {runs.map((run) => (
                      <RunRow
                        key={run.id}
                        run={run}
                        repos={repos}
                        changes={data.changes.filter((c) => c.runId === run.id)}
                        busy={busy}
                        open={() =>
                          setModal({ kind: "session", id: run.sessionId })
                        }
                        action={(action) =>
                          act(
                            () => api(`/runs/${run.id}/${action}`, {}),
                            "Run updated",
                          )
                        }
                      />
                    ))}
                  </div>
                )}
                {page === "workspace" && (
                  <div className="page-content">
                    <PageHeading
                      eyebrow="DEVELOPMENT ENVIRONMENT"
                      title={workspace.name}
                      description={workspace.root}
                      action={
                        <div className="heading-actions">
                          <button
                            className="primary"
                            onClick={() => setModal({ kind: "repository" })}
                          >
                            <Plus size={16} />
                            Add repository
                          </button>
                          <button
                            className="secondary danger"
                            onClick={() =>
                              setModal({ kind: "removeWorkspace", workspace })
                            }
                          >
                            <Trash2 size={16} /> Remove workspace
                          </button>
                        </div>
                      }
                    />
                    <WorkspaceSettings
                      workspace={workspace}
                      plugins={plugins}
                      save={(value) =>
                        act(() =>
                          api("/workspaces/" + workspaceID, value, "PATCH"),
                        )
                      }
                    />
                    <h2 className="section-title">
                      Repositories <span>{repos.length}</span>
                    </h2>
                    {!repos.length ? (
                      <Empty
                        icon={<FolderGit2 />}
                        title="Bring your code"
                        text="Clone a repository from Git or attach one already on this server."
                        action={
                          <button
                            className="secondary"
                            onClick={() => setModal({ kind: "repository" })}
                          >
                            Add repository
                          </button>
                        }
                      />
                    ) : (
                      repos.map((repo) => (
                        <div className="surface repo-row" key={repo.id}>
                          <FolderGit2 size={21} />
                          <div className="grow">
                            <h3>{repo.name}</h3>
                            <p className="mono">{repo.path}</p>
                            <p>{repo.remote || "Local repository"}</p>
                          </div>
                          {repo.remote && (
                            <select
                              aria-label={`Git provider for ${repo.name}`}
                              value={repo.integrationId || ""}
                              disabled={busy}
                              onChange={(e) =>
                                void act(
                                  () =>
                                    api(
                                      `/repositories/${repo.id}/integration`,
                                      {
                                        revision: repo.revision,
                                        integrationId: e.target.value,
                                      },
                                      "PATCH",
                                    ),
                                  "Provider connection updated",
                                )
                              }
                            >
                              <option value="">
                                Workspace account / generic Git
                              </option>
                              {integrations
                                .filter((i) =>
                                  ["github", "gitlab"].includes(i.provider),
                                )
                                .map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.label}
                                  </option>
                                ))}
                            </select>
                          )}
                          <span className="badge">{repo.provider}</span>
                          <span className="branch">
                            <GitBranch size={13} />
                            {repo.defaultBranch}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
                {page === "workspace" &&
                  worktrees.some((w) => w.hidden && w.status !== "removed") && (
                    <section className="settings-section">
                      <h2>Hidden worktrees</h2>
                      <p>
                        Restore a worktree to the sidebar without changing its
                        files.
                      </p>
                      {worktrees
                        .filter((w) => w.hidden && w.status !== "removed")
                        .map((w) => (
                          <div className="candidate-row" key={w.id}>
                            <span>
                              {w.name} · {w.branch}
                            </span>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () =>
                                    api(`/worktrees/${w.id}/actions/restore`, {
                                      revision: w.revision,
                                    }),
                                  "Worktree restored",
                                )
                              }
                            >
                              Restore
                            </button>
                          </div>
                        ))}
                    </section>
                  )}
                {page === "integrations" && (
                  <PluginCatalog
                    plugins={plugins}
                    connections={integrations}
                    add={(provider) =>
                      setModal({ kind: "integration", provider })
                    }
                    configure={chooseSettings}
                  />
                )}
                {page === "settings" &&
                  (selectedConnection ? (
                    <div className="settings-page">
                      <div className="settings-title">
                        <span className="eyebrow">
                          {["linear", "jira"].includes(
                            selectedConnection.provider,
                          )
                            ? "TRACKER"
                            : "VERSION CONTROL"}
                        </span>
                        <h1>{selectedConnection.label}</h1>
                        <p>
                          {pluginNames[selectedConnection.provider]} ·{" "}
                          {workspace.name}
                        </p>
                      </div>
                      <ConnectionTools
                        connection={selectedConnection}
                        workspace={workspace}
                        busy={busy}
                        act={act}
                        refresh={() => void refresh()}
                      />
                      <section className="settings-section">
                        <h2>Configuration</h2>
                        <IntegrationForm
                          key={selectedConnection.id}
                          initial={selectedConnection}
                          workspaceID={workspaceID}
                          busy={busy}
                          save={(value) =>
                            void act(
                              () => api("/integrations", value),
                              "Connection saved",
                            )
                          }
                        />
                      </section>
                    </div>
                  ) : (
                    <GeneralSettings
                      section={settingsSection}
                      plugins={plugins}
                      onProfilesSaved={() =>
                        api<Plugin[]>("/plugins").then(setPlugins)
                      }
                    />
                  ))}
                {page === "worktree" &&
                  (selectedWorktree ? (
                    <WorktreeView
                      key={selectedWorktree.id}
                      worktree={selectedWorktree}
                      runDetails={runs
                        .filter((r) =>
                          r.worktrees.some(
                            (w) =>
                              w.id === selectedWorktree.id ||
                              w.path === selectedWorktree.path,
                          ),
                        )
                        .map((run) => (
                          <RunRow
                            key={run.id}
                            run={run}
                            repos={repos}
                            changes={data.changes.filter(
                              (c) => c.runId === run.id,
                            )}
                            busy={busy}
                            open={() =>
                              setModal({ kind: "session", id: run.sessionId })
                            }
                            action={(action) =>
                              act(
                                () => api(`/runs/${run.id}/${action}`, {}),
                                "Run updated",
                              )
                            }
                          />
                        ))}
                      sessions={sessions}
                      runs={runs}
                      events={events}
                      csrf={data.csrf}
                      busy={busy}
                      plugins={plugins}
                      launch={(kind, harness) =>
                        void act(
                          () =>
                            api(`/worktrees/${selectedWorktree.id}/sessions`, {
                              kind,
                              harness: harness || workspace.workerHarness,
                              prompt: "",
                            }),
                          kind === "shell" ? "Terminal opened" : "Agent opened",
                        )
                      }
                      sessionAction={(id, action) =>
                        void act(
                          () => api(`/sessions/${id}/${action}`, {}),
                          "Session updated",
                        )
                      }
                      worktreeAction={(action) =>
                        void act(
                          () =>
                            api(
                              `/worktrees/${selectedWorktree.id}/actions/${action}`,
                              { revision: selectedWorktree.revision },
                            ),
                          "Worktree updated",
                        )
                      }
                    />
                  ) : (
                    <Empty
                      icon={<FolderGit2 />}
                      title="Your code, one worktree at a time"
                      text="Add a repository or select a worktree from the sidebar."
                      action={
                        <button
                          className="primary"
                          onClick={() => setModal({ kind: "repository" })}
                        >
                          Add repository
                        </button>
                      }
                    />
                  ))}
                {page === "attention" && (
                  <div className="page-content">
                    <PageHeading
                      eyebrow="THE NEXT MOVE IS YOURS"
                      title="Needs attention"
                      description="Approvals, blocked agents, and feedback waiting for a decision."
                    />
                    {attentionCount === 0 && (
                      <Empty
                        icon={<Check />}
                        title="You're all caught up"
                        text="When an agent needs a decision, it will appear here."
                      />
                    )}
                    {plans
                      .filter((p) => p.state === "draft")
                      .map((p) => (
                        <div className="surface attention-row" key={p.id}>
                          <ListTodo size={20} />
                          <div className="grow">
                            <h3>{p.title}</h3>
                            <p>Plan ready for your review</p>
                          </div>
                          <button
                            className="primary"
                            onClick={() => setModal({ kind: "plan", plan: p })}
                          >
                            Review
                          </button>
                        </div>
                      ))}
                    <SessionList
                      sessions={attentionSessions}
                      open={(id) => setModal({ kind: "session", id })}
                      hideEmpty
                    />
                    {runs
                      .filter((r) => r.state === "failed")
                      .map((r) => (
                        <div className="surface attention-row" key={r.id}>
                          <CircleHelp size={20} />
                          <div className="grow">
                            <h3>{r.task.title}</h3>
                            <p>{r.error}</p>
                          </div>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => api("/runs/" + r.id + "/retry", {}),
                                "Run queued",
                              )
                            }
                          >
                            Retry
                          </button>
                        </div>
                      ))}
                    {actions.map((action) => (
                      <ActionRow
                        key={action.id}
                        action={action}
                        busy={busy}
                        decide={(decision) =>
                          act(
                            () => api(`/actions/${action.id}/${decision}`, {}),
                            "Action updated",
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
      {modal && (
        <Dialog
          title={
            {
              newWorktree: "New worktree",
              startAgent: "Start agent",
              workspace: "Create workspace",
              importWorkspace: "Import workspace",
              removeWorkspace: "Remove workspace",
              repository: "Add repository",
              project: "Create project",
              issue:
                modal.kind === "issue" && modal.issue
                  ? modal.issue.identifier
                  : "New issue",
              plan: "Implementation plan",
              session: "Agent session",
              integration:
                modal.kind === "integration"
                  ? `${modal.integration ? "Configure" : "Add"} ${pluginNames[modal.provider || modal.integration?.provider || "linear"]}`
                  : "Connection",
            }[modal.kind]
          }
          wide={["plan", "session"].includes(modal.kind)}
          close={() => setModal(null)}
        >
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {modal.kind === "newWorktree" && (
            <NewWorktreeForm
              repo={modal.repo}
              issues={data.issues.filter((i) => i.workspaceId === workspaceID)}
              busy={busy}
              save={async (value, key) => {
                if (
                  await act(async () => {
                    const w = await api<Worktree>(
                      `/repositories/${modal.repo.id}/worktrees`,
                      value,
                      "POST",
                      key,
                    );
                    selectWorktree(w.id);
                  }, "Worktree created")
                )
                  setModal(null);
              }}
            />
          )}
          {modal.kind === "startAgent" && (
            <StartAgentForm
              plugins={plugins}
              defaultHarness={workspace?.workerHarness || "claude"}
              busy={busy}
              save={async (harness, prompt) => {
                if (
                  await act(
                    () =>
                      api(`/worktrees/${modal.worktree.id}/sessions`, {
                        kind: "agent",
                        harness,
                        prompt,
                      }),
                    "Agent started",
                  )
                )
                  setModal(null);
              }}
            />
          )}
          {modal.kind === "workspace" && (
            <WorkspaceForm
              save={async (value) => {
                if (
                  await act(async () => {
                    const created = await api<Workspace>("/workspaces", value);
                    setWorkspaceID(created.id);
                    setPage("workspace");
                  }, "Workspace created")
                )
                  setModal(null);
              }}
              busy={busy}
            />
          )}
          {modal.kind === "importWorkspace" && (
            <ImportWorkspaceForm
              busy={busy}
              save={async (value) => {
                if (
                  await act(async () => {
                    const imported = await api<Workspace>(
                      "/workspaces/import",
                      value,
                    );
                    setWorkspaceID(imported.id);
                    setPage("workspace");
                  }, "Workspace imported")
                )
                  setModal(null);
              }}
            />
          )}
          {modal.kind === "removeWorkspace" && (
            <div>
              <p>
                Remove <strong>{modal.workspace.name}</strong> from Autopilot?
              </p>
              <p className="muted">
                This deletes its local issues, plans, run history and
                integration connections. Repository folders, Git worktrees and
                external tracker issues stay intact.
              </p>
              <p className="muted">
                Complete or cancel its runs and stop agent sessions first.
                Pending updates will be discarded.
              </p>
              <div className="form-footer">
                <button
                  autoFocus
                  className="secondary"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  className="secondary danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await act(
                        () =>
                          api(
                            `/workspaces/${modal.workspace.id}`,
                            { revision: modal.workspace.revision },
                            "DELETE",
                          ),
                        "Workspace removed; code files kept",
                      )
                    )
                      setModal(null);
                  }}
                >
                  Remove workspace
                </button>
              </div>
            </div>
          )}
          {modal.kind === "repository" && workspace && (
            <RepositoryForm
              workspace={workspace}
              repos={repos}
              integrations={integrations}
              save={async (value) => {
                if (
                  await act(
                    () => api("/repositories", value),
                    "Repository added",
                  )
                )
                  setModal(null);
              }}
              busy={busy}
            />
          )}
          {modal.kind === "project" && (
            <ProjectForm
              save={async (value) => {
                if (
                  await act(
                    () =>
                      api("/projects", { ...value, workspaceId: workspaceID }),
                    "Project created",
                  )
                )
                  setModal(null);
              }}
              busy={busy}
            />
          )}
          {modal.kind === "issue" && (
            <IssueForm
              issue={
                modal.issue
                  ? data.issues.find((i) => i.id === modal.issue!.id) ||
                    modal.issue
                  : undefined
              }
              linkedPlans={plans.filter(
                (p) =>
                  modal.issue?.id === p.issueId ||
                  p.tasks.some((t) => t.issueId === modal.issue?.id),
              )}
              openPlan={(plan) => setModal({ kind: "plan", plan })}
              initialStatus={modal.status}
              workspaceID={workspaceID}
              projects={projects}
              projectID={project}
              comments={data.comments}
              integrations={integrations}
              busy={busy}
              save={async (value) => {
                if (
                  await act(
                    () =>
                      api(
                        modal.issue ? "/issues/" + modal.issue.id : "/issues",
                        value,
                        modal.issue ? "PATCH" : "POST",
                      ),
                    "Issue saved",
                  )
                )
                  setModal(null);
              }}
              note={(body) =>
                act(
                  () =>
                    api("/issues/" + modal.issue!.id + "/comments", { body }),
                  "Note added",
                )
              }
              transition={(kind, body) =>
                act(
                  () =>
                    api(
                      "/issues/" + modal.issue!.id + "/tracker",
                      { kind, body },
                      "POST",
                      crypto.randomUUID(),
                    ),
                  "Tracker action queued",
                )
              }
              plan={() => setModal({ kind: "plan", issue: modal.issue })}
            />
          )}
          {modal.kind === "plan" && workspace && (
            <PlanForm
              plan={modal.plan}
              issue={modal.issue}
              workspace={workspace}
              repos={repos}
              plugins={plugins}
              busy={busy}
              save={async (value) => {
                if (
                  await act(
                    () => api("/plans", value),
                    "Plan saved for approval",
                  )
                )
                  setModal(null);
              }}
              approve={async () => {
                if (
                  await act(
                    () =>
                      api(
                        `/plans/${modal.plan!.id}/approve`,
                        { revision: modal.plan!.revision },
                        "POST",
                        `approve:${modal.plan!.id}:${modal.plan!.revision}`,
                      ),
                    "Plan approved · workers will start as slots open",
                  )
                )
                  setModal(null);
              }}
            />
          )}
          {modal.kind === "session" && (
            <SessionDetail
              session={data.sessions.find((s) => s.id === modal.id)}
              csrf={data.csrf}
              events={events}
              busy={busy}
              act={(action, body, conversationId) =>
                act(
                  () =>
                    api(`/sessions/${modal.id}/${action}`, {
                      body,
                      conversationId,
                    }),
                  "Session updated",
                )
              }
            />
          )}
          {modal.kind === "integration" && (
            <IntegrationForm
              providerID={modal.provider}
              initial={modal.integration}
              workspaceID={workspaceID}
              busy={busy}
              save={async (value) => {
                if (
                  await act(async () => {
                    const connection = await api<Integration>(
                      "/integrations",
                      value,
                    );
                    chooseSettings(connection.id);
                  }, "Integration saved")
                )
                  setModal(null);
              }}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Dialog({
  title,
  wide,
  close,
  children,
}: {
  title: string;
  wide?: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            close();
        }
      }}
    >
      <div className="dialog-header">
        <strong>{title}</strong>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={19} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control =
    React.isValidElement<{ id?: string }>(children) &&
    typeof children.type === "string" &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div
      className="field"
      role={control ? undefined : "group"}
      aria-labelledby={control ? undefined : id}
    >
      {control ? (
        <label htmlFor={id}>{label}</label>
      ) : (
        <span id={id}>{label}</span>
      )}
      {control
        ? React.cloneElement(children as React.ReactElement<{ id: string }>, {
            id,
          })
        : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
function Submit({
  busy,
  children = "Save",
}: {
  busy: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button className="primary" disabled={busy} type="submit">
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
function WorkspaceForm({
  save,
  busy,
}: {
  save: (value: unknown) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(""),
    [root, setRoot] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ name, root });
      }}
    >
      <Field label="Workspace name">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme engineering"
        />
      </Field>
      <Field
        label="Existing workspace directory"
        hint="Optional. Leave empty to create a directory in managed storage. Paths refer to this server."
      >
        <input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="/data/workspaces/acme"
        />
      </Field>
      <div className="form-footer">
        <Submit busy={busy}>Create workspace</Submit>
      </div>
    </form>
  );
}
function ImportWorkspaceForm({
  save,
  busy,
}: {
  save: (value: {
    name: string;
    root: string;
    repositoryPaths: string[];
  }) => void;
  busy: boolean;
}) {
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const [scan, setScan] = useState<{ root: string; repositories: string[] }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const discover = async () => {
    setScanning(true);
    setError("");
    setScan(undefined);
    try {
      const result = await api<{ root: string; repositories: string[] }>(
        "/workspaces/scan",
        { root },
      );
      setScan(result);
      setSelected(result.repositories);
      setName(
        (current) =>
          current ||
          result.root.split("/").filter(Boolean).at(-1) ||
          "Workspace",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!scan) {
          void discover();
          return;
        }
        save({ name, root: scan.root, repositoryPaths: selected });
      }}
    >
      <Field
        label="Workspace directory"
        hint="An existing folder on this machine or server. Autopilot scans its immediate subfolders for Git repositories and keeps the files where they are."
      >
        <input
          autoFocus
          required
          disabled={busy || scanning}
          value={root}
          placeholder="~/code/my-workspace"
          onChange={(e) => {
            setRoot(e.target.value);
            setScan(undefined);
            setSelected([]);
            setError("");
          }}
        />
      </Field>
      <button
        type="button"
        className="secondary"
        disabled={busy || scanning || !root.trim()}
        onClick={() => void discover()}
      >
        {scanning ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Search size={15} />
        )}
        {scanning ? "Scanning…" : "Scan folder"}
      </button>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {scan && (
        <div className="workspace-scan">
          <Field label="Workspace name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <p className="muted mono">{scan.root}</p>
          <fieldset className="repository-picker">
            <legend>Repositories to import · {selected.length} selected</legend>
            {scan.repositories.map((path) => (
              <label key={path}>
                <input
                  type="checkbox"
                  checked={selected.includes(path)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, path]
                        : current.filter((p) => p !== path),
                    )
                  }
                />
                <span>
                  <strong>{path.split("/").at(-1)}</strong>
                  <small>{path}</small>
                </span>
              </label>
            ))}
            {!scan.repositories.length && (
              <p className="muted">
                No Git repositories found. Import this folder, then attach or
                clone repositories from Workspace settings.
              </p>
            )}
          </fieldset>
          <div className="form-footer">
            <Submit busy={busy || scanning}>Import workspace</Submit>
          </div>
        </div>
      )}
    </form>
  );
}
function ProjectForm({
  save,
  busy,
}: {
  save: (value: { name: string; description: string }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ name, description });
      }}
    >
      <Field label="Project name">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Customer onboarding"
        />
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="form-footer">
        <Submit busy={busy}>Create project</Submit>
      </div>
    </form>
  );
}
function RepositoryForm({
  workspace,
  repos,
  integrations,
  save,
  busy,
}: {
  workspace: Workspace;
  repos: Repository[];
  integrations: Integration[];
  save: (value: unknown) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState("clone"),
    [name, setName] = useState(""),
    [remote, setRemote] = useState(""),
    [path, setPath] = useState(""),
    [integrationId, setIntegration] = useState(""),
    [setup, setSetup] = useState(""),
    [discovered, setDiscovered] = useState<string[]>([]),
    [error, setError] = useState("");
  const integration = integrations.find((i) => i.id === integrationId);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({
          workspaceId: workspace.id,
          name,
          remote,
          path,
          clone: mode === "clone",
          integrationId,
          provider: integration?.provider || "",
          setup: setup.split("\n").filter(Boolean),
        });
      }}
    >
      <div className="segmented">
        <button
          type="button"
          className={mode === "clone" ? "active" : ""}
          onClick={() => setMode("clone")}
        >
          Clone from Git
        </button>
        <button
          type="button"
          className={mode === "attach" ? "active" : ""}
          onClick={() => setMode("attach")}
        >
          Attach existing
        </button>
      </div>
      {mode === "clone" ? (
        <>
          <Field label="Git URL">
            <input
              autoFocus
              required
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
              placeholder="git@github.com:acme/api.git"
            />
          </Field>
          <Field
            label="Directory name"
            hint={"Cloned inside " + workspace.root}
          >
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="api"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Repository path">
            <input
              autoFocus
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/data/workspaces/acme/api"
            />
          </Field>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              api<string[]>("/workspaces/" + workspace.id + "/discover")
                .then(setDiscovered)
                .catch((e) => setError(e.message))
            }
          >
            Scan workspace
          </button>
          {discovered
            .filter((p) => !repos.some((r) => r.path === p))
            .map((p) => (
              <button
                type="button"
                className="discovered"
                key={p}
                onClick={() => setPath(p)}
              >
                <FolderGit2 size={14} />
                {p}
              </button>
            ))}
          {error && <p className="inline-error">{error}</p>}
        </>
      )}
      <Field
        label="Git provider connection"
        hint="Cloning works without a provider. A connection enables PR/MR and CI tracking."
      >
        <select
          value={integrationId}
          onChange={(e) => setIntegration(e.target.value)}
        >
          <option value="">Workspace account / generic Git</option>
          {integrations
            .filter((i) => ["github", "gitlab"].includes(i.provider))
            .map((i) => (
              <option value={i.id} key={i.id}>
                {i.label}
              </option>
            ))}
        </select>
      </Field>
      <Field
        label="Worktree setup commands"
        hint="Optional. One shell command per line, run in each new worktree."
      >
        <textarea
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder="npm ci"
          rows={2}
        />
      </Field>
      <div className="form-footer">
        <Submit busy={busy}>
          {mode === "clone" ? "Clone repository" : "Attach repository"}
        </Submit>
      </div>
    </form>
  );
}
function WorkspaceSettings({
  workspace,
  plugins,
  save,
}: {
  workspace: Workspace;
  plugins: Plugin[];
  save: (w: Workspace) => Promise<boolean>;
}) {
  const [worker, setWorker] = useState(workspace.workerHarness),
    [orchestrator, setOrchestrator] = useState(workspace.orchestratorHarness);
  useEffect(() => {
    setWorker(workspace.workerHarness);
    setOrchestrator(workspace.orchestratorHarness);
  }, [workspace.id]);
  return (
    <div className="surface role-settings">
      <div>
        <h3>Two roles. Your choice of harness.</h3>
        <p>
          The orchestrator plans and coordinates. Workers implement approved
          tasks.
        </p>
      </div>
      <div className="form-grid">
        <Field label="Orchestrator harness">
          <select
            value={orchestrator}
            onChange={(e) => setOrchestrator(e.target.value)}
          >
            {plugins
              .filter((p) => p.type === "agent")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {!p.available ? " · unavailable" : ""}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Default worker harness">
          <select value={worker} onChange={(e) => setWorker(e.target.value)}>
            {plugins
              .filter((p) => p.type === "agent")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {!p.available ? " · unavailable" : ""}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <button
        className="secondary"
        onClick={() =>
          void save({
            ...workspace,
            workerHarness: worker,
            orchestratorHarness: orchestrator,
          })
        }
      >
        Save defaults
      </button>
    </div>
  );
}
function IssueForm({
  issue,
  linkedPlans,
  openPlan,
  initialStatus,
  workspaceID,
  projects,
  projectID,
  comments,
  integrations,
  busy,
  save,
  note,
  transition,
  plan,
}: {
  issue?: Issue;
  linkedPlans: Plan[];
  openPlan: (p: Plan) => void;
  initialStatus?: string;
  workspaceID: string;
  projects: Project[];
  projectID: string;
  comments: Snapshot["comments"];
  integrations: Integration[];
  busy: boolean;
  save: (v: unknown) => void;
  note: (body: string) => Promise<boolean>;
  transition: (kind: string, body: string) => Promise<boolean>;
  plan: () => void;
}) {
  const [title, setTitle] = useState(issue?.title || ""),
    [description, setDescription] = useState(issue?.description || ""),
    [acceptance, setAcceptance] = useState(issue?.acceptance || ""),
    [status, setStatus] = useState(issue?.status || initialStatus || "backlog"),
    [priority, setPriority] = useState(issue?.priority || 0),
    [project, setProject] = useState(issue?.projectId || projectID),
    [labels, setLabels] = useState(issue?.labels?.join(", ") || ""),
    [body, setBody] = useState(""),
    [externalStatus, setExternalStatus] = useState(""),
    [statuses, setStatuses] = useState<Record<string, string>>({});
  const external = !!issue && issue.source !== "native";
  useEffect(() => {
    if (external)
      api<Record<string, string>>(
        `/integrations/${issue.integrationId}/statuses`,
      )
        .then(setStatuses)
        .catch(() => {});
  }, [issue?.id]);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({
            ...issue,
            workspaceId: workspaceID,
            title,
            description,
            acceptance,
            status,
            priority,
            projectId: project,
            labels: labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }}
      >
        <Field label="Title">
          <input
            className="title-input"
            autoFocus
            required
            readOnly={external}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to happen?"
          />
        </Field>
        {issue && (
          <div className="issue-progress">
            <span className={`progress-dot state-${issue.workflowState}`} />
            {issue.workflowDetail || "Waiting for coordinator"}
            {linkedPlans.map((p) => (
              <button
                type="button"
                className="secondary"
                key={p.id}
                onClick={() => openPlan(p)}
              >
                <ListTodo size={13} />
                {p.state === "draft" ? "Review plan" : "View plan"}
              </button>
            ))}
          </div>
        )}
        <Field label="Description">
          <textarea
            rows={5}
            readOnly={external}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Context, desired behavior, and anything the agent should know…"
          />
        </Field>
        <Field label="Acceptance criteria">
          <textarea
            readOnly={external}
            rows={2}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder="How will we know this is done?"
          />
        </Field>
        {issue && (
          <details className="issue-extra">
            <summary>Additional details</summary>{" "}
            <div className="form-grid">
              <Field label="Project">
                <select
                  disabled={external}
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Labels">
                <input
                  readOnly={external}
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  placeholder="frontend, bug"
                />
              </Field>
            </div>
          </details>
        )}
        <div className="form-footer">
          {issue && !linkedPlans.length && (
            <button className="secondary" type="button" onClick={plan}>
              <ListTodo size={15} />
              Plan this issue
            </button>
          )}
          {external ? (
            <a
              className="secondary"
              href={issue.externalUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open in {issue.source}
              <ArrowUpRight size={14} />
            </a>
          ) : (
            <Submit busy={busy}>
              {issue ? "Save changes" : "Create issue"}
            </Submit>
          )}
        </div>
      </form>
      {external && (
        <div className="subsection">
          <h3>Tracker status</h3>
          <p className="muted">
            {issue.externalStatus} ·{" "}
            {integrations.find((i) => i.id === issue.integrationId)?.label}
          </p>
          <div className="inline-form">
            <select
              aria-label="External status"
              value={externalStatus}
              onChange={(e) => setExternalStatus(e.target.value)}
            >
              <option value="">Choose a tracker status</option>
              {Object.entries(statuses).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="secondary"
              disabled={busy || !externalStatus}
              onClick={() => void transition("tracker.status", externalStatus)}
            >
              Request change
            </button>
          </div>
        </div>
      )}
      {issue && (
        <div className="subsection">
          <h3>Notes</h3>
          {comments
            .filter((c) => c.issueId === issue.id)
            .map((c) => (
              <div className="comment" key={c.id}>
                <strong>{c.author || "You"}</strong>
                <small>{new Date(c.createdAt).toLocaleString()}</small>
                <p>{c.body}</p>
              </div>
            ))}
          <textarea
            aria-label="New note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add context or leave a note…"
          />
          <div className="form-footer">
            <button
              className="secondary"
              disabled={busy || !body.trim()}
              onClick={async () => {
                if (await note(body)) setBody("");
              }}
            >
              Add private note
            </button>
            {external && (
              <button
                className="secondary"
                disabled={busy || !body.trim()}
                onClick={async () => {
                  if (await transition("tracker.comment", body)) setBody("");
                }}
              >
                Post to tracker
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
function PlanForm({
  plan,
  issue,
  workspace,
  repos,
  plugins,
  busy,
  save,
  approve,
}: {
  plan?: Plan;
  issue?: Issue;
  workspace: Workspace;
  repos: Repository[];
  plugins: Plugin[];
  busy: boolean;
  save: (v: unknown) => void;
  approve: () => void;
}) {
  const [title, setTitle] = useState(plan?.title || issue?.title || ""),
    [summary, setSummary] = useState(plan?.summary || ""),
    [tasks, setTasks] = useState<Task[]>(
      plan?.tasks || [
        {
          id: crypto.randomUUID(),
          issueId: issue?.id || "",
          title: issue?.title || "",
          prompt: [issue?.description, issue?.acceptance]
            .filter(Boolean)
            .join("\n\n"),
          repositoryIds: repos.length === 1 ? [repos[0].id] : [],
          dependsOn: [],
          harness: workspace.workerHarness,
        },
      ],
    );
  const approved = plan?.state === "approved";
  const changed =
    !!plan &&
    JSON.stringify({ title, summary, tasks }) !==
      JSON.stringify({
        title: plan.title,
        summary: plan.summary,
        tasks: plan.tasks,
      });
  const edit = (index: number, patch: Partial<Task>) =>
    setTasks(tasks.map((t, n) => (n === index ? { ...t, ...patch } : t)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({
          ...plan,
          workspaceId: workspace.id,
          issueId: plan?.issueId || issue?.id || "",
          title,
          summary,
          tasks,
        });
      }}
    >
      <Field label="Plan title">
        <input
          required
          readOnly={approved}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ship a better onboarding flow"
        />
      </Field>
      <Field label="Approach">
        <textarea
          readOnly={approved}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Explain the approach and the boundaries of this work."
        />
      </Field>
      <div className="section-title">
        Tasks<span>{tasks.length}</span>
      </div>
      {tasks.map((task, index) => (
        <div className="plan-task" key={task.id}>
          <div className="task-heading">
            <span className="task-number">{index + 1}</span>
            <input
              aria-label={`Task ${index + 1} title`}
              required
              readOnly={approved}
              value={task.title}
              onChange={(e) => edit(index, { title: e.target.value })}
              placeholder="A focused piece of work"
            />
            {!approved && tasks.length > 1 && (
              <button
                type="button"
                aria-label="Remove task"
                onClick={() =>
                  setTasks(
                    tasks
                      .filter((t) => t.id !== task.id)
                      .map((t) => ({
                        ...t,
                        dependsOn: t.dependsOn.filter((id) => id !== task.id),
                      })),
                  )
                }
              >
                <X size={16} />
              </button>
            )}
          </div>
          <Field label="Instructions and acceptance criteria">
            <textarea
              required
              readOnly={approved}
              value={task.prompt}
              onChange={(e) => edit(index, { prompt: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="form-grid">
            <Field label="Worker harness">
              <select
                disabled={approved}
                value={task.harness}
                onChange={(e) => edit(index, { harness: e.target.value })}
              >
                {plugins
                  .filter((p) => p.type === "agent")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Repositories">
              <div className="check-list">
                {repos.map((repo) => (
                  <label key={repo.id}>
                    <input
                      type="checkbox"
                      disabled={approved}
                      checked={task.repositoryIds.includes(repo.id)}
                      onChange={(e) =>
                        edit(index, {
                          repositoryIds: e.target.checked
                            ? [...task.repositoryIds, repo.id]
                            : task.repositoryIds.filter((id) => id !== repo.id),
                        })
                      }
                    />
                    {repo.name}
                  </label>
                ))}
                {!repos.length && (
                  <span className="muted">Add a repository first.</span>
                )}
              </div>
            </Field>
          </div>
          {tasks.length > 1 && (
            <Field label="Wait for these tasks to finish">
              <div className="check-list">
                {tasks
                  .filter((t) => t.id !== task.id)
                  .map((other) => (
                    <label key={other.id}>
                      <input
                        type="checkbox"
                        disabled={approved}
                        checked={task.dependsOn.includes(other.id)}
                        onChange={(e) =>
                          edit(index, {
                            dependsOn: e.target.checked
                              ? [...task.dependsOn, other.id]
                              : task.dependsOn.filter((id) => id !== other.id),
                          })
                        }
                      />
                      {other.title || "Untitled task"}
                    </label>
                  ))}
              </div>
            </Field>
          )}
        </div>
      ))}
      {!approved && (
        <button
          className="secondary"
          type="button"
          onClick={() =>
            setTasks([
              ...tasks,
              {
                id: crypto.randomUUID(),
                issueId: "",
                title: "",
                prompt: "",
                repositoryIds: [],
                dependsOn: [],
                harness: workspace.workerHarness,
              },
            ])
          }
        >
          <Plus size={15} />
          Add task
        </button>
      )}
      <div className="approval-note">
        <CircleHelp size={16} />
        <span>
          {approved
            ? "This approved revision is immutable."
            : "Approval allows these tasks to run in the listed repositories. Additional scope requires a new plan."}
        </span>
      </div>
      <div className="form-footer">
        {!approved && <Submit busy={busy}>Save plan</Submit>}
        {plan?.state === "draft" && (
          <button
            className="primary"
            disabled={busy || changed}
            title={changed ? "Save your changes before approving" : undefined}
            type="button"
            onClick={approve}
          >
            Approve & queue workers
          </button>
        )}
      </div>
    </form>
  );
}
function SessionList({
  sessions,
  open,
  hideEmpty,
}: {
  sessions: Session[];
  open: (id: string) => void;
  hideEmpty?: boolean;
}) {
  if (!sessions.length)
    return hideEmpty ? null : (
      <Empty
        icon={<TerminalSquare />}
        title="No sessions yet"
        text="Start an orchestrator, or approve a plan to launch workers."
      />
    );
  return (
    <div className="session-grid">
      {sessions.map((s) => (
        <button
          className="surface session-card"
          key={s.id}
          onClick={() => open(s.id)}
        >
          <div className="session-card-top">
            <TerminalSquare size={19} />
            <span
              className={
                "badge " +
                (s.state === "needs_input" ? "amber" : isLive(s) ? "green" : "")
              }
            >
              {s.state.replaceAll("_", " ")}
            </span>
          </div>
          <h3>{s.harness.label}</h3>
          <p>
            {s.role === "orchestrator"
              ? "Workspace orchestrator"
              : "Implementation worker"}
          </p>
          {s.error && <small className="inline-error">{s.error}</small>}
          <div className="session-card-bottom">
            <span className="mono">{s.handle.slice(0, 15)}</span>
            <ArrowUpRight size={15} />
          </div>
        </button>
      ))}
    </div>
  );
}
function RunRow({
  run,
  repos,
  changes,
  busy,
  open,
  action,
}: {
  run: Run;
  repos: Repository[];
  changes: Change[];
  busy: boolean;
  open: () => void;
  action: (v: string) => Promise<boolean>;
}) {
  return (
    <div className="surface run-row">
      <div className="run-row-heading">
        <div>
          <h3>{run.task.title}</h3>
          <p>
            {run.task.harness} · {run.repairs} follow-ups
          </p>
        </div>
        <span className="badge">{run.state}</span>
      </div>
      {run.error && <p className="inline-error">{run.error}</p>}
      {run.worktrees.map((w) => (
        <div className="worktree" key={w.repositoryId}>
          <GitBranch size={14} />
          <strong>{repos.find((r) => r.id === w.repositoryId)?.name}</strong>
          <code>{w.branch}</code>
        </div>
      ))}
      {changes.map((c) => (
        <a
          className="change-link"
          key={c.id}
          href={c.url}
          target="_blank"
          rel="noreferrer"
        >
          <GitPullRequest size={15} />#{c.number} {c.title}
          <span className="badge">
            {c.state} · {c.checks}
          </span>
          <ArrowUpRight size={14} />
        </a>
      ))}
      <div className="form-footer">
        {run.sessionId && (
          <button className="secondary" onClick={open}>
            Open session
          </button>
        )}
        {run.state === "failed" && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action("retry")}
          >
            Retry preparation
          </button>
        )}
        {!["completed", "canceled"].includes(run.state) && (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (confirm("Accept this run as complete and stop its agent?"))
                  void action("complete");
              }}
            >
              Accept result
            </button>
            <button
              className="text-button muted"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Cancel this run and stop its agent? Worktrees will be retained.",
                  )
                )
                  void action("cancel");
              }}
            >
              Cancel run
            </button>
          </>
        )}
        {["completed", "canceled"].includes(run.state) &&
          run.worktrees.length > 0 && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void action("cleanup")}
            >
              Clean up worktrees
            </button>
          )}
      </div>
    </div>
  );
}
function SessionDetail({
  session,
  csrf,
  events,
  busy,
  act,
}: {
  session?: Session;
  csrf: string;
  events: Event[];
  busy: boolean;
  act: (
    action: string,
    body: string,
    conversationId: string,
  ) => Promise<boolean>;
}) {
  const [reply, setReply] = useState(""),
    [conversation, setConversation] = useState(session?.conversationId || ""),
    [preview, setPreview] = useState("");
  useEffect(() => {
    if (!session) return;
    api<{ preview: string }>("/sessions/" + session.id + "/preview")
      .then((v) => setPreview(v.preview))
      .catch(() => {});
  }, [session?.id]);
  if (!session) return <p>Session not found.</p>;
  return (
    <>
      <div className="session-detail-heading">
        <div>
          <h2>
            {session.harness.label}
            <span className="badge">{session.role}</span>
          </h2>
          <p className="mono">{session.directory}</p>
        </div>
        <span className="badge">{session.state.replaceAll("_", " ")}</span>
      </div>
      {session.error && <p className="inline-error">{session.error}</p>}
      {isLive(session) ? (
        <Suspense fallback={<p className="muted">Opening terminal…</p>}>
          <Terminal id={session.id} csrf={csrf} />
        </Suspense>
      ) : (
        <pre className="terminal-preview">
          {preview ||
            "No live terminal. Workspace files and run history are retained."}
        </pre>
      )}
      <div className="session-controls">
        {isLive(session) ? (
          <>
            <form
              className="inline-form grow"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await act("send", reply, "")) setReply("");
              }}
            >
              <input
                aria-label="Reply to agent"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply to this agent…"
              />
              <button className="primary" disabled={busy || !reply.trim()}>
                Send
              </button>
            </form>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void act("interrupt", "", "")}
            >
              Interrupt
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Stop this agent? Its files and conversation will be retained.",
                  )
                )
                  void act("stop", "", "");
              }}
            >
              Stop
            </button>
          </>
        ) : (
          <div className="inline-form">
            <input
              aria-label="Conversation ID"
              value={conversation}
              onChange={(e) => setConversation(e.target.value)}
              placeholder="Exact native conversation ID"
            />
            <button
              className="primary"
              disabled={busy || !conversation.trim()}
              onClick={() => void act("resume", "", conversation)}
            >
              Resume conversation
            </button>
          </div>
        )}
      </div>
      <details className="subsection">
        <summary>Initial instructions</summary>
        <pre className="prompt">{session.prompt}</pre>
        <button
          className="secondary"
          disabled={!isLive(session) || busy}
          onClick={() => void act("send", session.prompt, "")}
        >
          Send saved prompt
        </button>
      </details>
      <div className="subsection">
        <h3>Activity</h3>
        {events
          .filter(
            (e) => e.entityId === session.id || e.entityId === session.runId,
          )
          .slice(-12)
          .reverse()
          .map((e) => (
            <div className="event" key={e.sequence}>
              <span className="dot" />
              <span>{e.message || e.kind}</span>
              <time>
                {new Date(e.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ))}
      </div>
    </>
  );
}
function ActionRow({
  action,
  busy,
  decide,
}: {
  action: Action;
  busy: boolean;
  decide: (v: string) => Promise<boolean>;
}) {
  return (
    <div className="surface action-row">
      <div className="run-row-heading">
        <h3>
          {action.kind === "notice"
            ? "Issue needs attention"
            : action.kind === "orchestrator.followup"
              ? "Orchestrator update"
              : action.kind === "agent.followup"
                ? "Worker follow-up"
                : action.kind === "tracker.comment"
                  ? "Tracker comment"
                  : "Tracker status change"}
        </h3>
        <span className="badge amber">{action.state}</span>
      </div>
      <p className="action-body">{action.body}</p>
      {action.error && <p className="inline-error">{action.error}</p>}
      <div className="form-footer">
        {["agent.followup", "orchestrator.followup"].includes(action.kind) ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  "Send this text to the agent’s current prompt? Check its terminal first.",
                )
              )
                void decide("send");
            }}
          >
            Send to agent
          </button>
        ) : (
          ["uncertain", "delivering"].includes(action.state) && (
            <>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void decide("confirmed")}
              >
                Confirmed in tracker
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Retry only if you checked the tracker and the previous action was not applied.",
                    )
                  )
                    void decide("retry");
                }}
              >
                Retry after checking
              </button>
            </>
          )
        )}
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void decide("dismiss")}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
function IntegrationForm({
  providerID,
  initial,
  workspaceID,
  busy,
  save,
}: {
  providerID?: string;
  initial?: Integration;
  workspaceID: string;
  busy: boolean;
  save: (v: unknown) => void;
}) {
  const [provider] = useState(initial?.provider || providerID || "linear"),
    [label, setLabel] = useState(initial?.label || ""),
    [baseUrl, setBaseURL] = useState(initial?.baseUrl || ""),
    [username, setUsername] = useState(initial?.username || ""),
    [scope, setScope] = useState(initial?.scope || ""),
    [token, setToken] = useState(""),
    [enabled, setEnabled] = useState(initial?.enabled ?? true),
    [mapping, setMapping] = useState(initial?.statusMap || {}),
    [statuses, setStatuses] = useState<Record<string, string>>({}),
    [error, setError] = useState("");
  const [pollInterval, setPollInterval] = useState(initial?.pollInterval || 60),
    [intakeEnabled, setIntakeEnabled] = useState(
      initial?.intakeEnabled || false,
    ),
    [watchStatuses, setWatchStatuses] = useState<string[]>(
      initial?.watchStatuses || [],
    ),
    [authMethod, setAuthMethod] = useState(initial?.authMethod || "token"),
    [cliAccount, setCLIAccount] = useState(initial?.cliAccount || "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({
          ...initial,
          workspaceId: workspaceID,
          provider,
          label,
          baseUrl,
          username,
          scope,
          token,
          enabled,
          statusMap: mapping,
          pollInterval,
          intakeEnabled,
          watchStatuses,
          authMethod,
          cliAccount,
        });
      }}
    >
      <Field label="Connection name">
        <input
          autoFocus={!initial}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Engineering"
        />
      </Field>
      <Field
        label="Base URL"
        hint={
          provider === "gitlab"
            ? "For self-hosted GitLab, include /api/v4."
            : provider === "jira"
              ? "Your Jira site URL is required."
              : "Optional; uses the provider’s public API by default."
        }
      >
        <input
          type="url"
          required={provider === "jira"}
          value={baseUrl}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder={
            provider === "jira"
              ? "https://acme.atlassian.net"
              : provider === "gitlab"
                ? "https://gitlab.com/api/v4"
                : "Default provider API"
          }
        />
      </Field>
      {provider === "jira" && (
        <Field label="Account email">
          <input
            type="email"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
      )}
      {provider === "github" && (
        <Field label="Authentication">
          <select
            value={authMethod}
            onChange={(e) => setAuthMethod(e.target.value)}
          >
            <option value="token">Access token</option>
            <option value="cli">GitHub CLI account</option>
          </select>
        </Field>
      )}
      {authMethod === "cli" ? (
        <Field
          label="GitHub CLI username"
          hint="Uses this account's credential without switching the CLI's active account. The credential is saved for this workspace connection."
        >
          <input
            required
            value={cliAccount}
            onChange={(e) => setCLIAccount(e.target.value)}
          />
        </Field>
      ) : (
        <>
          {" "}
          <Field
            label={initial ? "Replace access token" : "Access token"}
            hint="Stored in the server’s private secrets directory. Never returned by the API."
          >
            <input
              type="password"
              autoComplete="new-password"
              required={!initial && authMethod === "token"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </>
      )}
      {["linear", "jira"].includes(provider) && (
        <Field
          label={provider === "linear" ? "Team keys" : "Project keys"}
          hint="Comma-separated keys to synchronize."
        >
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="ENG, WEB"
          />
        </Field>
      )}
      {["linear", "jira"].includes(provider) && (
        <>
          <Field label="Poll interval (seconds)">
            <input
              type="number"
              min={10}
              max={86400}
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
            />
          </Field>
          <div className="settings-note">
            <strong>Polling</strong>
            <p>
              Polling keeps tickets synchronized. After saving, you can also
              configure a signed webhook in this connection’s settings.
            </p>
            <p>
              OAuth sign-in is reserved for the desktop distribution. Cloud uses
              a server credential.
            </p>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={intakeEnabled}
              onChange={(e) => setIntakeEnabled(e.target.checked)}
            />
            Queue tickets entering watched statuses
          </label>
          <p className="muted">
            The first sync establishes a baseline. Eligible transitions queue
            tickets for planning; they do not start agents.
          </p>
        </>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enabled
      </label>
      {initial && ["linear", "jira"].includes(provider) && (
        <div className="subsection">
          <button
            className="secondary"
            type="button"
            onClick={() =>
              api<Record<string, string>>(
                `/integrations/${initial.id}/statuses`,
              )
                .then(setStatuses)
                .catch((e) => setError(e.message))
            }
          >
            Load workflow statuses
          </button>
          {Object.entries(statuses).map(([id, name]) => (
            <label className="watch-status" key={id}>
              <input
                type="checkbox"
                checked={watchStatuses.includes(id)}
                onChange={(e) =>
                  setWatchStatuses((v) =>
                    e.target.checked ? [...v, id] : v.filter((x) => x !== id),
                  )
                }
              />
              <span>Watch {name}</span>
            </label>
          ))}
          {Object.entries(statuses).map(([id, name]) => (
            <Field label={name} key={id}>
              <select
                value={mapping[id] || ""}
                onChange={(e) =>
                  setMapping({ ...mapping, [id]: e.target.value })
                }
              >
                <option value="">Provider default</option>
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {error && <p className="inline-error">{error}</p>}
        </div>
      )}
      <div className="form-footer">
        <Submit busy={busy}>Save connection</Submit>
      </div>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

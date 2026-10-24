import { useEffect, useState } from "react";
import {
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  FolderGit2,
  GitPullRequest,
  ListTodo,
  Plus,
  Settings2,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { api } from "./api";
import {
  columns,
  Integration,
  Plugin,
  Profile,
  Workspace,
  Worktree,
} from "./types";
export const pluginNames: Record<string, string> = {
  native: "Autopilot",
  linear: "Linear",
  jira: "Jira Cloud",
  github: "GitHub",
  gitlab: "GitLab",
  tmux: "Terminal",
};
export function PluginMark({ id, type }: { id: string; type: string }) {
  const Icon =
    type === "tracker"
      ? ListTodo
      : type === "git-provider"
        ? GitPullRequest
        : type === "agent"
          ? Zap
          : TerminalSquare;
  return (
    <span className={`plugin-mark mark-${id}`}>
      <Icon size={20} />
    </span>
  );
}
export function SettingsNavigation({
  section,
  connections,
  choose,
}: {
  section: string;
  connections: Integration[];
  choose: (s: string) => void;
}) {
  const fixed = [
    { id: "general", name: "General", icon: Settings2 },
    { id: "workspace", name: "Workspace", icon: FolderGit2 },
    { id: "plugins", name: "Plugins", icon: Boxes },
    { id: "agents", name: "Agents", icon: Zap },
    { id: "terminal", name: "Terminal", icon: TerminalSquare },
    { id: "activity", name: "Activity & errors", icon: CircleHelp },
  ];
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <h2>Settings</h2>
      {fixed.map((s) => (
        <button
          className={section === s.id ? "active" : ""}
          key={s.id}
          onClick={() => choose(s.id)}
        >
          <s.icon size={15} />
          {s.name}
        </button>
      ))}
      {[
        { type: "tracker", name: "Trackers", ids: ["linear", "jira"] },
        {
          type: "git-provider",
          name: "Version control",
          ids: ["github", "gitlab"],
        },
      ].map((group) => (
        <div className="settings-connections" key={group.type}>
          <h3>{group.name}</h3>
          {connections
            .filter((i) => group.ids.includes(i.provider))
            .map((i) => (
              <button
                key={i.id}
                className={section === i.id ? "active" : ""}
                onClick={() => choose(i.id)}
                title={i.label}
              >
                <span
                  className={`connection-dot ${i.error ? "error" : i.lastVerified ? "verified" : ""}`}
                />
                <span>{i.label}</span>
              </button>
            ))}
          <button className="muted" onClick={() => choose("plugins")}>
            <Plus size={13} />
            Add {group.type === "tracker" ? "tracker" : "account"}
          </button>
        </div>
      ))}
    </nav>
  );
}
export function PluginCatalog({
  plugins,
  connections,
  add,
  configure,
}: {
  plugins: Plugin[];
  connections: Integration[];
  add: (provider: string) => void;
  configure: (section: string) => void;
}) {
  const groups = [
    {
      type: "tracker",
      name: "Trackers",
      description:
        "Bring issues into your workspace and choose what enters the planning queue.",
    },
    {
      type: "git-provider",
      name: "Version control",
      description:
        "Connect an account for pull requests, checks and review feedback.",
    },
    {
      type: "agent",
      name: "Agents",
      description: "Choose the coding tools that work in your terminals.",
    },
    {
      type: "launcher",
      name: "Launchers",
      description:
        "The built-in terminal is ready. Desktop launchers can be added in the desktop distribution.",
    },
  ];
  return (
    <div className="settings-page">
      <div className="settings-title">
        <span className="eyebrow">MAKE IT YOURS</span>
        <h1>Plugins</h1>
        <p>Add the services you use. Each connection has its own settings.</p>
      </div>
      {groups.map((group) => (
        <section className="plugin-category" key={group.type}>
          <h2>{group.name}</h2>
          <p>{group.description}</p>
          <div className="plugin-cards">
            {plugins
              .filter((p) => p.type === group.type)
              .map((p) => {
                const matching = connections.filter((i) => i.provider === p.id);
                const builtIn = ["native", "tmux"].includes(p.id),
                  agent = p.type === "agent";
                const status = !p.available
                  ? "Unavailable"
                  : builtIn
                    ? "Built in"
                    : agent
                      ? "CLI available"
                      : matching.length
                        ? `${matching.length} connection${matching.length > 1 ? "s" : ""}`
                        : "Not configured";
                return (
                  <article key={p.id} className="plugin-card">
                    <div className="plugin-card-top">
                      <PluginMark id={p.id} type={p.type} />
                      <div>
                        <h3>{p.label}</h3>
                        <span>{status}</span>
                      </div>
                    </div>
                    <p>
                      {p.reason ||
                        (p.id === "native"
                          ? "Your local issues and horizontal board."
                          : p.id === "linear"
                            ? "Teams, workflow statuses and issue intake."
                            : p.id === "jira"
                              ? "Projects, issue transitions and polling."
                              : p.id === "github"
                                ? "Pull requests, GitHub Actions and reviews."
                                : p.id === "gitlab"
                                  ? "Merge requests, pipelines and discussions."
                                  : p.id === "tmux"
                                    ? "Persistent shells and agent sessions in your browser."
                                    : "Manual work or approved tasks, using your configured CLI.")}
                    </p>
                    <div className="plugin-card-actions">
                      {!builtIn && !agent && (
                        <button
                          className={matching.length ? "secondary" : "primary"}
                          onClick={() => add(p.id)}
                        >
                          <Plus size={14} />
                          {matching.length ? "Add account" : "Add"}
                        </button>
                      )}
                      <button
                        className="secondary"
                        onClick={() =>
                          configure(
                            agent
                              ? "agents"
                              : p.id === "tmux"
                                ? "terminal"
                                : p.id === "native"
                                  ? "native"
                                  : matching[0]?.id || "plugins",
                          )
                        }
                        disabled={!builtIn && !agent && !matching.length}
                      >
                        {!p.available ? "Setup" : "Configure"}
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
type SettingsInfo = {
  distribution: string;
  executionEnvironment: string;
  dataDirectory: string;
  maxWorkers: number;
  maxOrchestrators: number;
  retentionDays: number;
  profiles: Profile[];
};
export function GeneralSettings({
  section,
  plugins,
  onProfilesSaved,
}: {
  section: string;
  plugins: Plugin[];
  onProfilesSaved: () => void;
}) {
  const [info, setInfo] = useState<SettingsInfo>(),
    [error, setError] = useState("");
  useEffect(() => {
    api<SettingsInfo>("/settings")
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [section]);
  const [font, setFont] = useState(() =>
    Number(localStorage.getItem("autopilot.terminalFont") || 13),
  );
  if (section === "native")
    return (
      <div className="settings-page">
        <div className="settings-title">
          <h1>Autopilot tracker</h1>
          <p>Your native issues stay local to this installation.</p>
        </div>
        <section className="settings-section">
          <h2>Workflow</h2>
          <div className="native-statuses">
            {columns.map((c) => (
              <span key={c.id}>
                <i style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
          </div>
          <p>
            Use project filters and the horizontal board to organize work. Move
            an issue by dragging it or changing its status. Plans still require
            approval.
          </p>
        </section>
      </div>
    );
  if (section === "terminal")
    return (
      <div className="settings-page">
        <div className="settings-title">
          <h1>Terminal</h1>
          <p>Persistent sessions, built into your worktree.</p>
        </div>
        <section className="settings-section">
          <h2>Appearance</h2>
          <label className="setting-field">
            Font size
            <select
              value={font}
              onChange={(e) => {
                setFont(Number(e.target.value));
                localStorage.setItem("autopilot.terminalFont", e.target.value);
              }}
            >
              {[11, 12, 13, 14, 15, 16, 18, 20].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <p>
            Applies to terminals opened in this browser. Closing a tab detaches;
            Stop ends the process. Each session supports multiple viewers and
            one input controller.
          </p>
        </section>
        <section className="settings-section">
          <h2>Launchers</h2>
          <p>
            Cloud sessions use the embedded terminal. External desktop tools are
            not enabled in this distribution.
          </p>
        </section>
      </div>
    );
  return (
    <div className="settings-page">
      <div className="settings-title">
        <h1>{section === "agents" ? "Agents" : "General"}</h1>
        <p>
          {section === "agents"
            ? "Configure harnesses. Workspace defaults choose the worker and coordinator independently."
            : "Your local installation and storage."}
        </p>
      </div>
      {error && <p className="inline-error">{error}</p>}
      {section === "agents"
        ? info?.profiles.map((p) => (
            <ProfileEditor
              key={p.id}
              profile={p}
              plugin={plugins.find((v) => v.id === p.id)}
              saved={onProfilesSaved}
            />
          ))
        : info && (
            <>
              <section className="settings-section">
                <h2>Installation</h2>
                <dl className="settings-facts">
                  <dt>Distribution</dt>
                  <dd>{info.distribution}</dd>
                  <dt>Execution environment</dt>
                  <dd>{info.executionEnvironment}</dd>
                  <dt>Data directory</dt>
                  <dd>{info.dataDirectory}</dd>
                  <dt>Worker limit</dt>
                  <dd>{info.maxWorkers}</dd>
                  <dt>Coordinator limit</dt>
                  <dd>{info.maxOrchestrators}</dd>
                  <dt>Managed run retention</dt>
                  <dd>
                    {info.retentionDays} days; pinned and manual worktrees are
                    retained
                  </dd>
                </dl>
                <p>
                  Deployment settings are configured in settings.json in the
                  data directory and applied on restart.
                </p>
              </section>
            </>
          )}
    </div>
  );
}
function ProfileEditor({
  profile,
  plugin,
  saved,
}: {
  profile: Profile;
  plugin?: Plugin;
  saved: () => void;
}) {
  const [command, setCommand] = useState(profile.command),
    [args, setArgs] = useState(JSON.stringify(profile.args || [])),
    [resume, setResume] = useState(JSON.stringify(profile.resumeArgs || [])),
    [mode, setMode] = useState(profile.promptMode),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <details className="settings-section profile-editor">
      <summary>
        <PluginMark id={profile.id} type="agent" />
        <strong>{profile.label}</strong>
        <span>
          {plugin?.available
            ? "CLI available · login not verified"
            : "Setup required"}
        </span>
      </summary>
      <form
        className="workbench-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setDone(false);
          try {
            const parsedArgs = JSON.parse(args),
              parsedResume = JSON.parse(resume);
            if (
              !Array.isArray(parsedArgs) ||
              !Array.isArray(parsedResume) ||
              [...parsedArgs, ...parsedResume].some(
                (x) => typeof x !== "string",
              )
            )
              throw Error("Arguments must be JSON arrays of strings");
            await api("/settings/profiles", {
              ...profile,
              command,
              args: parsedArgs,
              resumeArgs: parsedResume,
              promptMode: mode,
            });
            setDone(true);
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Executable
          <input
            required
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label>
          Launch arguments{" "}
          <small>JSON array; include your model flags here</small>
          <input value={args} onChange={(e) => setArgs(e.target.value)} />
        </label>
        <label>
          Resume arguments{" "}
          <small>Use {"{conversation}"} for the saved conversation ID</small>
          <input value={resume} onChange={(e) => setResume(e.target.value)} />
        </label>
        <label>
          Prompt delivery
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="arg">Command argument</option>
            <option value="paste">Send after confirming readiness</option>
          </select>
        </label>
        <p className="muted">
          Install and sign in to the CLI on the machine running Autopilot.
          Existing sessions and approved plans keep their captured profile.
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {done && (
          <p className="success-message">
            <Check size={14} />
            Saved
          </p>
        )}
        <div className="form-footer">
          <button className="primary" disabled={busy}>
            Save profile
          </button>
        </div>
      </form>
    </details>
  );
}
export type Candidate = {
  worktreeId: string;
  worktreeName: string;
  branch: string;
  identifier: string;
  issueId: string;
  linked: boolean;
};
export function ConnectionTools({
  connection: i,
  workspace,
  busy,
  act,
  refresh,
}: {
  connection: Integration;
  workspace: Workspace;
  busy: boolean;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<boolean>;
  refresh: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]),
    [scanned, setScanned] = useState(false),
    [signingSecret, setSigningSecret] = useState(""),
    [error, setError] = useState("");
  const tracker = ["linear", "jira"].includes(i.provider);
  const account =
    i.provider === "github"
      ? workspace.githubAccountId
      : workspace.gitlabAccountId;
  return (
    <>
      <section className="settings-section">
        <h2>Connection</h2>
        <p>
          {i.verifiedAccount
            ? `Verified as ${i.verifiedAccount}`
            : "Account has not been verified yet."}
        </p>
        {i.error && <p className="inline-error">{i.error}</p>}
        <div className="heading-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(
                () => api(`/integrations/${i.id}/verify`, {}),
                "Connection verified",
              )
            }
          >
            Test connection
          </button>
          {tracker && (
            <button
              className="secondary"
              disabled={busy || !i.enabled}
              onClick={() =>
                void act(
                  () => api(`/integrations/${i.id}/sync`, {}),
                  "Sync complete",
                )
              }
            >
              Sync now
            </button>
          )}
          {!tracker && (
            <button
              className="secondary"
              disabled={busy || account === i.id}
              onClick={() =>
                void act(
                  () =>
                    api(
                      `/workspaces/${workspace.id}`,
                      {
                        ...workspace,
                        [i.provider === "github"
                          ? "githubAccountId"
                          : "gitlabAccountId"]: i.id,
                      },
                      "PATCH",
                    ),
                  "Workspace account updated",
                )
              }
            >
              {account === i.id
                ? "Workspace default"
                : "Use for this workspace"}
            </button>
          )}
        </div>
        <small>
          {i.lastSync
            ? `Last sync: ${new Date(i.lastSync).toLocaleString()}`
            : "No sync recorded"}
        </small>
        {!tracker && (
          <p>
            Repository settings can override this workspace's API account. Git
            transport and commit author identity use your configured Git
            credentials independently.
          </p>
        )}
      </section>
      {tracker && (
        <section className="settings-section">
          <h2>Signed webhooks</h2>
          <p>
            Receive changes immediately while polling remains a fallback.
            Configure this URL in your tracker; a local server needs an
            externally reachable HTTPS address.
          </p>
          <code className="webhook-url">
            {location.origin}/hooks/{i.id}
          </code>
          <label>
            Signing secret
            <input
              type="password"
              autoComplete="new-password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="Enter the secret configured in your tracker"
            />
          </label>
          <div className="heading-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                if (
                  await act(
                    () =>
                      api(`/integrations/${i.id}/webhook`, {
                        enabled: true,
                        secret: signingSecret,
                      }),
                    "Webhook enabled",
                  )
                )
                  setSigningSecret("");
              }}
            >
              {i.webhookEnabled ? "Update signing secret" : "Enable webhook"}
            </button>
            {i.webhookEnabled && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      api(`/integrations/${i.id}/webhook`, {
                        enabled: false,
                        secret: "",
                      }),
                    "Webhook disabled",
                  )
                }
              >
                Disable webhook
              </button>
            )}
          </div>
          <p>
            {i.lastWebhook
              ? `Last verified delivery: ${new Date(i.lastWebhook).toLocaleString()}`
              : "No verified delivery yet."}
          </p>
        </section>
      )}
      {tracker && (
        <section className="settings-section">
          <h2>Discover tickets from worktrees</h2>
          <p>
            Match branch names to synchronized tickets. Review links before
            applying them; linking does not queue or launch work.
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setError("");
              api<Candidate[]>(`/integrations/${i.id}/discover-tickets`)
                .then((v) => {
                  setCandidates(v);
                  setScanned(true);
                })
                .catch((e) => setError(e.message));
            }}
          >
            Discover tickets
          </button>
          {error && <p className="inline-error">{error}</p>}
          {scanned && !candidates.length && (
            <p>No ticket identifiers found in current worktrees.</p>
          )}
          {candidates.map((c) => (
            <div className="candidate-row" key={c.worktreeId + c.identifier}>
              <div>
                <strong>{c.identifier}</strong>
                <p>
                  {c.worktreeName} · {c.branch}
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy || c.linked || !c.issueId}
                onClick={async () => {
                  if (
                    await act(
                      () =>
                        api(`/worktrees/${c.worktreeId}/issues`, {
                          issueId: c.issueId,
                        }),
                      "Ticket linked",
                    )
                  ) {
                    setCandidates((all) =>
                      all.map((x) => (x === c ? { ...x, linked: true } : x)),
                    );
                    refresh();
                  }
                }}
              >
                {c.linked
                  ? "Linked"
                  : c.issueId
                    ? "Link ticket"
                    : "Sync ticket first"}
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

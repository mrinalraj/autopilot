import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** True inside a `bun build --compile` binary, where sources live in Bun's virtual filesystem. */
export const COMPILED = import.meta.url.includes("$bunfs") || import.meta.dir.includes("~BUN");

/**
 * Where config.json, state/ and logs/ live: AUTOPILOT_HOME if set, Application Support for the
 * compiled app, and the project directory when running from source.
 */
export const HOME_DIR = process.env.AUTOPILOT_HOME
  ? expandHome(process.env.AUTOPILOT_HOME)
  : COMPILED
    ? appSupport()
    : resolve(import.meta.dir, "..");

/** Application Support folder; moves the one from when the app was called linear-autopilot. */
function appSupport(): string {
  const dir = join(homedir(), "Library", "Application Support", "autopilot");
  const legacy = join(homedir(), "Library", "Application Support", "linear-autopilot");
  if (!existsSync(dir) && existsSync(legacy)) renameSync(legacy, dir);
  return dir;
}

export const CONFIG_PATH = process.env.AUTOPILOT_CONFIG ?? join(HOME_DIR, "config.json");
/** Homebrew prefix when running from a Homebrew install (its `brew services` logs to var/log). */
const BREW_PREFIX = COMPILED ? process.execPath.match(/^(.*)\/Cellar\//)?.[1] ?? null : null;
export const LOG_PATH = BREW_PREFIX ? join(BREW_PREFIX, "var", "log", "autopilot.log") : join(HOME_DIR, "logs", "autopilot.log");

import { TRACKER_KINDS, TRACKERS, type TrackerKind } from "./tracker";

export const LAUNCHERS = ["supacode", "worktrunk", "git", "vscode", "cursor"] as const;
export type LauncherName = (typeof LAUNCHERS)[number];

export interface Config {
  /** Which tracker to watch; each keeps its own state under stateDir. */
  tracker: TrackerKind;
  jira: {
    /** Site to use when the account can reach several, by URL or name (e.g. acme.atlassian.net). Empty = the first. */
    site: string;
    /** Jira's own pickupStates / importStates (status names differ between trackers). */
    pickupStates?: string[];
    importStates?: string[];
  };
  pollIntervalSeconds: number;
  /** How often launched items are checked for commits and PRs (local git + gh). */
  workCheckIntervalSeconds: number;
  port: number;
  /** Loopback port for the one-time OAuth redirect during `bun run login`. */
  oauthCallbackPort: number;
  /** "folder": every git repo directly inside reposRoot. "list": exactly the repos in repoPaths. */
  repoMode: "folder" | "list";
  reposRoot: string;
  repoPaths: string[];
  /** Ticket prefixes (ENG, IT, …) recognised in branch and worktree names. Empty = my Linear teams' keys. */
  ticketPrefixes: string[];
  /** Default: <home>/state for Linear, <home>/state/jira for Jira, so their tickets never mix. */
  stateDir: string;
  /** Read-only ticket briefs rendered from the DB for the Claude session. Default: <stateDir>/briefs */
  briefsDir: string;
  /** GitHub account (`gh auth login`) used for PR tracking. Empty = gh's active account. */
  githubUser: string;
  /** Linear user ID to treat as "me". Empty = use the API key's viewer. */
  linearUserId: string;
  /**
   * Linear status names (case-insensitive) a ticket assigned to me must be in to be picked up.
   * A ticket is proposed when it enters "assigned to me + one of these states". Empty = any open state.
   */
  pickupStates: string[];
  /** My tickets in these Linear statuses are shown under In progress, mapped to their worktrees. */
  importStates: string[];
  /** Scan every repo's worktrees for ticket numbers in branch names and show those tickets too. */
  importWorktrees: boolean;
  /** Prompt for tickets already eligible on the very first run (default: baseline them silently). */
  processExistingOnFirstRun: boolean;
  /** Move the Linear issue to its team's "started" state on approve (login must include the write scope). */
  moveToInProgressOnApprove: boolean;
  lowConfidenceThreshold: number;
  llm: {
    /** "cli" = `claude -p` (uses your Claude Code login), "api" = Anthropic SDK with ANTHROPIC_API_KEY. */
    provider: "cli" | "api";
    model: string;
    claudeBin: string;
  };
  launch: {
    /** Who creates worktrees and hosts the Claude session. */
    launcher: LauncherName;
    /** Where Claude opens for launchers without their own (worktrunk, git, vscode, cursor); "none" only creates worktrees. */
    terminal: "terminal" | "iterm" | "warp" | "none";
    /** VS Code / Cursor: open Claude in the editor's chat panel (prompt pre-filled) or in the terminal. */
    ideSession: "chat" | "terminal";
    /** Cursor's chat panel: Cursor's own agent, or the Claude Code extension. */
    cursorChat: "cursor" | "claude";
    /** Where the git, vscode and cursor launchers put worktrees. Default: <reposRoot>/wt */
    worktreesDir: string;
    supacodeBin: string;
    claudeBin: string;
    fetch: boolean;
    base: string;
    background: boolean;
  };
  /** Per-repo overrides: { "<repo name>": { description?, exclude? } } */
  repos: Record<string, { description?: string; exclude?: boolean }>;
}

const DEFAULTS: Config = {
  tracker: "linear",
  jira: { site: "" },
  pollIntervalSeconds: 1200,
  workCheckIntervalSeconds: 300,
  port: COMPILED ? 4747 : 4800, // from source, stay clear of the installed app
  oauthCallbackPort: 4748,
  repoMode: "folder",
  reposRoot: join(homedir(), "code"),
  repoPaths: [],
  ticketPrefixes: [],
  stateDir: "",
  briefsDir: "",
  githubUser: "",
  linearUserId: "",
  pickupStates: ["Ready for Development"],
  importStates: ["In Development"],
  importWorktrees: true,
  processExistingOnFirstRun: false,
  moveToInProgressOnApprove: false,
  lowConfidenceThreshold: 0.6,
  llm: {
    provider: "cli",
    model: "claude-opus-5-5",
    claudeBin: "claude",
  },
  launch: {
    launcher: "supacode",
    terminal: "terminal",
    ideSession: "chat",
    cursorChat: "cursor",
    worktreesDir: "",
    supacodeBin: "/Applications/supacode.app/Contents/Resources/bin/supacode",
    claudeBin: "claude",
    fetch: true,
    base: "",
    background: false,
  },
  repos: {},
};

export function loadConfig(path = CONFIG_PATH): Config {
  const user = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    jira: { ...DEFAULTS.jira, ...user.jira },
    llm: { ...DEFAULTS.llm, ...user.llm },
    launch: { ...DEFAULTS.launch, ...user.launch },
    repos: { ...DEFAULTS.repos, ...user.repos },
  };
  cfg.reposRoot = expandHome(cfg.reposRoot);
  cfg.repoPaths = (cfg.repoPaths ?? []).map(expandHome);
  if (cfg.repoMode !== "list") cfg.repoMode = "folder";
  cfg.ticketPrefixes = (cfg.ticketPrefixes ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (!TRACKER_KINDS.includes(cfg.tracker)) cfg.tracker = "linear";
  if (cfg.tracker === "jira") {
    cfg.pickupStates = cfg.jira.pickupStates ?? DEFAULTS.pickupStates;
    cfg.importStates = cfg.jira.importStates ?? DEFAULTS.importStates;
  }
  cfg.stateDir = cfg.stateDir ? expandHome(cfg.stateDir) : join(HOME_DIR, "state", ...(cfg.tracker === "jira" ? ["jira"] : []));
  cfg.briefsDir = cfg.briefsDir ? expandHome(cfg.briefsDir) : join(cfg.stateDir, "briefs");
  cfg.launch.worktreesDir = cfg.launch.worktreesDir
    ? expandHome(cfg.launch.worktreesDir)
    : cfg.repoMode === "list" ? join(homedir(), "worktrees") : join(cfg.reposRoot, "wt");
  if (!LAUNCHERS.includes(cfg.launch.launcher)) cfg.launch.launcher = "supacode";
  return cfg;
}

export function baseUrl(cfg: Config): string {
  return `http://localhost:${cfg.port}`;
}

export const oauthRedirectUrl = (cfg: Config) => `http://127.0.0.1:${cfg.oauthCallbackPort}/callback`;
export const oauthScope = (cfg: Config) => TRACKERS[cfg.tracker].scope(cfg);

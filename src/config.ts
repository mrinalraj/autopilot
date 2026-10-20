import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandHome(p: string): string {
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
    ? join(homedir(), "Library", "Application Support", "linear-autopilot")
    : resolve(import.meta.dir, "..");

export const CONFIG_PATH = process.env.AUTOPILOT_CONFIG ?? join(HOME_DIR, "config.json");
export const LOG_PATH = join(HOME_DIR, "logs", "autopilot.log");

export interface Config {
  pollIntervalSeconds: number;
  /** How often launched items are checked for commits and PRs (local git + gh). */
  workCheckIntervalSeconds: number;
  port: number;
  /** Loopback port for the one-time OAuth redirect during `bun run login`. */
  oauthCallbackPort: number;
  reposRoot: string;
  stateDir: string;
  /** Read-only ticket briefs rendered from the DB for the Claude session. Default: <stateDir>/briefs */
  briefsDir: string;
  /** Linear user ID to treat as "me". Empty = use the API key's viewer. */
  linearUserId: string;
  /**
   * Linear status names (case-insensitive) a ticket assigned to me must be in to be picked up.
   * A ticket is proposed when it enters "assigned to me + one of these states". Empty = any open state.
   */
  pickupStates: string[];
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
  pollIntervalSeconds: 1200,
  workCheckIntervalSeconds: 300,
  port: 4747,
  oauthCallbackPort: 4748,
  reposRoot: join(homedir(), "code"),
  stateDir: join(HOME_DIR, "state"),
  briefsDir: "",
  linearUserId: "",
  pickupStates: ["Ready for Development"],
  processExistingOnFirstRun: false,
  moveToInProgressOnApprove: false,
  lowConfidenceThreshold: 0.6,
  llm: {
    provider: "cli",
    model: "claude-opus-5-5",
    claudeBin: "claude",
  },
  launch: {
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
    llm: { ...DEFAULTS.llm, ...user.llm },
    launch: { ...DEFAULTS.launch, ...user.launch },
    repos: { ...DEFAULTS.repos, ...user.repos },
  };
  cfg.reposRoot = expandHome(cfg.reposRoot);
  cfg.stateDir = expandHome(cfg.stateDir);
  cfg.briefsDir = cfg.briefsDir ? expandHome(cfg.briefsDir) : join(cfg.stateDir, "briefs");
  return cfg;
}

export function baseUrl(cfg: Config): string {
  return `http://localhost:${cfg.port}`;
}

export const oauthRedirectUrl = (cfg: Config) => `http://127.0.0.1:${cfg.oauthCallbackPort}/callback`;
export const oauthScope = (cfg: Config) => (cfg.moveToInProgressOnApprove ? "read write" : "read");

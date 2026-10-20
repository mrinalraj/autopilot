import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PROJECT_DIR = resolve(import.meta.dir, "..");

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
  stateDir: join(PROJECT_DIR, "state"),
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

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path = process.env.AUTOPILOT_CONFIG ?? join(PROJECT_DIR, "config.json")): Config {
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

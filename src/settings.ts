import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, expandHome, LAUNCHERS, loadConfig, type Config, type LauncherName } from "./config";
import { listRepos, repoSources } from "./catalog";
import { TRACKER_KINDS, type TrackerKind } from "./tracker";

export interface GithubStatus {
  installed: boolean;
  accounts: { name: string; active: boolean }[];
}

/** gh on this machine: installed, and the github.com accounts logged in (for the PR-tracking picker). */
export function githubStatus(): GithubStatus {
  if (!Bun.which("gh", { PATH: process.env.PATH })) return { installed: false, accounts: [] };
  try {
    const p = Bun.spawnSync(["gh", "auth", "status", "-h", "github.com"], { stdout: "pipe", stderr: "pipe", env: process.env });
    const accounts: GithubStatus["accounts"] = [];
    for (const line of `${p.stdout}${p.stderr}`.split("\n")) {
      const acct = /Logged in to github\.com account (\S+)/.exec(line)?.[1];
      if (acct) accounts.push({ name: acct, active: false });
      else if (/Active account: true/.test(line) && accounts.length) accounts[accounts.length - 1].active = true;
    }
    return { installed: true, accounts };
  } catch {
    return { installed: true, accounts: [] };
  }
}

export const githubAccounts = (): string[] => githubStatus().accounts.map((a) => a.name);

type Raw = Record<string, any>;
const readRaw = (path: string): Raw => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

/** Edits config.json (keeping keys nobody manages here) and applies it to the running config. */
export function patchConfig(cfg: Config, patch: (raw: Raw) => void, path = CONFIG_PATH) {
  const raw = readRaw(path);
  patch(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  Object.assign(cfg, loadConfig(path));
}

/** Problems with a set of parent folders and individual repos, or none. */
export function checkRepos(roots: string[], paths: string[]): string[] {
  const errors: string[] = [];
  for (const r of roots) {
    const p = expandHome(r);
    if (!existsSync(p) || !statSync(p).isDirectory()) errors.push(`Folder "${r}" doesn't exist.`);
  }
  for (const p of paths) if (!existsSync(join(expandHome(p), ".git"))) errors.push(`"${p}" isn't a git repo.`);
  if (errors.length) return errors;
  if (!roots.length && !paths.length) return ["Add at least one folder or repo."];
  if (!repoSources({ repoRoots: roots.map(expandHome), repoPaths: paths.map(expandHome) } as Config).length) return ["No git repos found in those folders."];
  return [];
}

export function writeRepos(raw: Raw, roots: string[], paths: string[]) {
  raw.repoRoots = roots;
  raw.repoPaths = paths;
  delete raw.reposRoot;
  delete raw.repoMode;
}

/** Folders picked in Finder: a git repo joins the individual repos, anything else the parent folders. */
export function addPicked(cfg: Config, picked: string[], path = CONFIG_PATH): string[] {
  const roots = [...cfg.repoRoots];
  const paths = [...cfg.repoPaths];
  for (const p of picked.map((x) => x.replace(/\/$/, ""))) {
    const list = existsSync(join(p, ".git")) ? paths : roots;
    if (!list.includes(p)) list.push(p);
  }
  const errors = checkRepos(roots, paths);
  if (!errors.length) patchConfig(cfg, (raw) => writeRepos(raw, roots, paths), path);
  return errors;
}

/** Pickup/import statuses from a form; each tracker keeps its own (Linear's at the top level, for older configs). */
export function writeStatuses(raw: Raw, cfg: Config, form: FormData) {
  const states = { pickupStates: list(form, "pickupStates", "pickupStatesOther"), importStates: list(form, "importStates", "importStatesOther") };
  if (cfg.tracker === "jira") raw.jira = { ...raw.jira, ...states };
  else Object.assign(raw, states);
  raw.importWorktrees = form.get("importWorktrees") === "on";
}

export interface SaveResult {
  errors: string[];
  /** Changes that only take effect after a restart (or another step). */
  notes: string[];
}

const list = (form: FormData, name: string, other: string) =>
  [...new Set([...form.getAll(name).map(String), ...String(form.get(other) ?? "").split(",")].map((s) => s.trim()).filter(Boolean))];

/**
 * Validates the settings form, writes config.json (keeping keys the page doesn't manage), and
 * applies the new values to the running config in place.
 */
export function saveSettings(cfg: Config, form: FormData, path = CONFIG_PATH): SaveResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const num = (name: string, min: number, max: number, label: string) => {
    const v = Number(form.get(name));
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${label} must be between ${min} and ${max}.`);
    return v;
  };

  const pollMinutes = num("pollMinutes", 1, 1440, "Poll interval (minutes)");
  const workMinutes = num("workMinutes", 1, 1440, "PR check interval (minutes)");
  const threshold = num("lowConfidenceThreshold", 0, 1, "Low-confidence threshold");
  const lines = (name: string) => String(form.get(name) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const repoRoots = lines("repoRoots");
  const repoPaths = lines("repoPaths");
  errors.push(...checkRepos(repoRoots, repoPaths));
  const ticketPrefixes = String(form.get("ticketPrefixes") ?? "").split(/[\s,]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
  for (const p of ticketPrefixes) if (!/^[A-Z][A-Z0-9]{0,9}$/.test(p)) errors.push(`Ticket prefix "${p}" should be letters/digits, like ENG.`);
  const launcher = String(form.get("launcher") ?? "") as LauncherName;
  if (!LAUNCHERS.includes(launcher)) errors.push("Pick a launcher.");
  const terminal = String(form.get("terminal") ?? "terminal");
  if (!["terminal", "iterm", "warp", "none"].includes(terminal)) errors.push("Pick a terminal.");
  const provider = String(form.get("provider") ?? "cli");
  if (!["cli", "api"].includes(provider)) errors.push("Pick an LLM backend.");
  const model = String(form.get("model") ?? "").trim();
  if (!model) errors.push("Model can't be empty.");
  if (errors.length) return { errors, notes };

  const raw = readRaw(path);
  const before = { provider: cfg.llm.provider, move: cfg.moveToInProgressOnApprove };

  writeStatuses(raw, cfg, form);
  raw.pollIntervalSeconds = Math.round(pollMinutes * 60);
  raw.workCheckIntervalSeconds = Math.round(workMinutes * 60);
  writeRepos(raw, repoRoots, repoPaths);
  raw.ticketPrefixes = ticketPrefixes;
  raw.githubUser = String(form.get("githubUser") ?? "");
  raw.moveToInProgressOnApprove = form.get("moveToInProgressOnApprove") === "on";
  raw.lowConfidenceThreshold = threshold;
  raw.llm = { ...raw.llm, provider, model };
  raw.launch = {
    ...raw.launch,
    launcher,
    terminal,
    worktreesDir: String(form.get("worktreesDir") ?? "").trim(),
    fetch: form.get("fetch") === "on",
    base: String(form.get("base") ?? "").trim(),
    background: form.get("background") === "on",
    ideSession: form.get("ideSession") === "terminal" ? "terminal" : "chat",
    cursorChat: form.get("cursorChat") === "claude" ? "claude" : "cursor",
  };

  // Repo catalog: descriptions that differ from the derived ones, and exclusions.
  const repos: Record<string, { description?: string; exclude?: boolean }> = {};
  for (const r of listRepos({ ...cfg, repoRoots: repoRoots.map(expandHome), repoPaths: repoPaths.map(expandHome) })) {
    const desc = String(form.get(`desc:${r.name}`) ?? "").trim();
    const entry: { description?: string; exclude?: boolean } = {};
    if (desc && desc !== r.derived) entry.description = desc;
    if (form.has(`present:${r.name}`) && form.get(`include:${r.name}`) !== "on") entry.exclude = true;
    if (Object.keys(entry).length) repos[r.name] = entry;
  }
  raw.repos = repos;

  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  Object.assign(cfg, loadConfig(path));

  if (provider !== before.provider) notes.push("The LLM backend changes after a restart.");
  if (raw.moveToInProgressOnApprove && !before.move && cfg.tracker === "linear") {
    notes.push("Moving tickets to In Progress needs Linear write access: sign in again (Switch account) once.");
  }
  return { errors, notes };
}

/**
 * Saves the tracker choice (and Jira site) without touching the running config: the store, briefs
 * and connection belong to the old tracker until the daemon restarts.
 */
export function saveTracker(form: FormData, path = CONFIG_PATH): { ok: true; tracker: TrackerKind } | { ok: false; error: string } {
  const tracker = String(form.get("tracker") ?? "") as TrackerKind;
  if (!TRACKER_KINDS.includes(tracker)) return { ok: false, error: "Pick Linear or Jira." };
  const site = String(form.get("jiraSite") ?? "").trim();
  if (site && !/^[\w.-]+(\.[\w.-]+)*(\/.*)?$/.test(site.replace(/^https?:\/\//, ""))) return { ok: false, error: `"${site}" doesn't look like a Jira site.` };
  const raw = readRaw(path);
  raw.tracker = tracker;
  if (form.has("jiraSite")) raw.jira = { ...raw.jira, site };
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return { ok: true, tracker };
}

/** Back to default settings, keeping what the sign-in and the address depend on; setup runs again. */
export function resetSettingsFile(path = CONFIG_PATH) {
  const raw = readRaw(path);
  const kept: Raw = { onboarded: false };
  for (const k of ["tracker", "port", "oauthCallbackPort"]) if (k in raw) kept[k] = raw[k];
  if (raw.jira?.site) kept.jira = { site: raw.jira.site };
  writeFileSync(path, JSON.stringify(kept, null, 2) + "\n");
}

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, expandHome, LAUNCHERS, loadConfig, type Config, type LauncherName } from "./config";
import { listRepos, repoSources } from "../repos/catalog";
import { TRACKER_KINDS, type TrackerKind } from "../trackers/tracker";

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
  const states = { pickupStates: form.get("pickupMode") === "any" ? [] : list(form, "pickupStates", "pickupStatesOther"), importStates: list(form, "importStates", "importStatesOther") };
  if (cfg.tracker === "jira") raw.jira = { ...raw.jira, ...states };
  else Object.assign(raw, states);
  raw.importWorktrees = form.get("importWorktrees") === "on";
}

export interface SaveResult {
  errors: string[];
  /** Changes that only take effect after a restart (or another step). */
  notes: string[];
  fields?: Record<string, string>;
}

const list = (form: FormData, name: string, other: string) =>
  [...new Set([...form.getAll(name).map(String), ...String(form.get(other) ?? "").split(",")].map((s) => s.trim()).filter(Boolean))];

/**
 * Validates the settings form, writes config.json (keeping keys the page doesn't manage), and
 * applies the new values to the running config in place.
 */
export function saveSettings(cfg: Config, form: FormData, path = CONFIG_PATH): SaveResult {
  const errors: string[] = [], notes: string[] = [];
  const fields: Record<string, string> = {};
  const section = String(form.get("section") ?? "");
  const sections = ["connections", "tickets", "repositories", "launch", "ai"];
  if (section && !sections.includes(section)) return { errors: ["Unknown settings section."], notes };
  const editing = (name: string) => !section || section === name;
  const error = (name: string, message: string) => { errors.push(message); fields[name] = message; };
  const num = (name: string, min: number, max: number, label: string) => {
    const value = Number(form.get(name));
    if (!form.has(name) || !Number.isFinite(value) || value < min || value > max) error(name, `${label} must be between ${min} and ${max}.`);
    return value;
  };
  const pollMinutes = editing("tickets") ? num("pollMinutes", 1, 1440, "Poll interval (minutes)") : 0;
  const workMinutes = editing("tickets") ? num("workMinutes", 1, 1440, "PR check interval (minutes)") : 0;
  if (editing("tickets") && form.get("pickupMode") === "selected" && !list(form, "pickupStates", "pickupStatesOther").length) error("pickupMode", "Choose at least one status, or explicitly choose Any open status.");
  const threshold = editing("ai") ? num("lowConfidenceThreshold", 0, 1, "Low-confidence threshold") : 0;
  const lines = (name: string) => String(form.get(name) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const roots = lines("repoRoots"), paths = lines("repoPaths");
  if (editing("repositories")) {
    for (const message of checkRepos(roots, paths)) error("repoRoots", message);
  }
  const prefixes = String(form.get("ticketPrefixes") ?? "").split(/[\s,]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (editing("tickets")) for (const p of prefixes) if (!/^[A-Z][A-Z0-9]{0,9}$/.test(p)) error("ticketPrefixes", `Ticket prefix "${p}" should be letters/digits, like ENG.`);
  const launcher = String(form.get("launcher") ?? "") as LauncherName;
  const terminal = String(form.get("terminal") ?? "terminal");
  if (editing("launch")) {
    if (!LAUNCHERS.includes(launcher)) error("launcher", "Pick a launcher.");
    if (!["terminal", "iterm", "warp", "none"].includes(terminal)) error("terminal", "Pick a terminal.");
  }
  const provider = String(form.get("provider") ?? "cli"), model = String(form.get("model") ?? "").trim();
  if (editing("ai")) {
    if (!["cli", "api"].includes(provider)) error("provider", "Pick an LLM backend.");
    if (!model) error("model", "Model can't be empty.");
  }
  if (errors.length) return { errors, notes, fields };
  const raw = readRaw(path);
  if (editing("tickets")) {
    writeStatuses(raw, cfg, form);
    raw.pollIntervalSeconds = Math.round(pollMinutes * 60);
    raw.workCheckIntervalSeconds = Math.round(workMinutes * 60);
    raw.ticketPrefixes = prefixes;
    raw.moveToInProgressOnApprove = form.get("moveToInProgressOnApprove") === "on";
    if (raw.moveToInProgressOnApprove && !cfg.moveToInProgressOnApprove && cfg.tracker === "linear") notes.push("Moving tickets to In Progress needs Linear write access: sign in again (Switch account) once.");
  }
  if (editing("connections")) raw.githubUser = String(form.get("githubUser") ?? "");
  if (editing("ai")) {
    raw.lowConfidenceThreshold = threshold;
    raw.llm = { ...raw.llm, provider, model };
    if (provider !== cfg.llm.provider) notes.push("The LLM backend changes after a restart.");
  }
  if (editing("launch")) raw.launch = {
    ...raw.launch, launcher, terminal,
    worktreesDir: String(form.get("worktreesDir") ?? "").trim(),
    fetch: form.get("fetch") === "on", base: String(form.get("base") ?? "").trim(), background: form.get("background") === "on",
    ideSession: form.get("ideSession") === "terminal" ? "terminal" : "chat",
    cursorChat: form.get("cursorChat") === "claude" ? "claude" : "cursor",
  };
  if (editing("repositories")) {
    writeRepos(raw, roots, paths);
    const repos: Config["repos"] = {};
    for (const r of listRepos({ ...cfg, repoRoots: roots.map(expandHome), repoPaths: paths.map(expandHome) })) {
      // The catalogue may still be loading: preserve overrides for controls not submitted.
      if (!form.has(`present:${r.name}`)) { if (cfg.repos[r.name]) repos[r.name] = cfg.repos[r.name]; continue; }
      const entry: Config["repos"][string] = {};
      const desc = String(form.get(`desc:${r.name}`) ?? "").trim();
      if (desc && desc !== r.derived) entry.description = desc;
      if (form.get(`include:${r.name}`) !== "on") entry.exclude = true;
      if (Object.keys(entry).length) repos[r.name] = entry;
    }
    raw.repos = repos;
  }
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  Object.assign(cfg, loadConfig(path));
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

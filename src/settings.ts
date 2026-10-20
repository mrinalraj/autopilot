import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, expandHome, LAUNCHERS, loadConfig, type Config, type LauncherName } from "./config";
import { listRepos } from "./catalog";

/** gh accounts logged in on this machine (for the PR-tracking account picker). */
export function githubAccounts(): string[] {
  try {
    const p = Bun.spawnSync(["gh", "auth", "status", "-h", "github.com"], { stdout: "pipe", stderr: "pipe", env: process.env });
    const text = `${p.stdout}${p.stderr}`;
    return [...text.matchAll(/account (\S+)/g)].map((m) => m[1]);
  } catch {
    return [];
  }
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
  const repoMode = form.get("repoMode") === "list" ? "list" : "folder";
  const reposRoot = String(form.get("reposRoot") ?? "").trim();
  const repoPaths = String(form.get("repoPaths") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (repoMode === "folder" && (!reposRoot || !existsSync(expandHome(reposRoot)) || !statSync(expandHome(reposRoot)).isDirectory())) {
    errors.push(`Code folder "${reposRoot}" doesn't exist.`);
  }
  if (repoMode === "list") {
    if (!repoPaths.length) errors.push("Add at least one repo path, or switch to a parent folder.");
    for (const p of repoPaths) if (!existsSync(`${expandHome(p)}/.git`)) errors.push(`"${p}" isn't a git repo.`);
  }
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

  const raw: Record<string, any> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const before = { provider: cfg.llm.provider, move: cfg.moveToInProgressOnApprove };

  raw.pickupStates = list(form, "pickupStates", "pickupStatesOther");
  raw.importStates = list(form, "importStates", "importStatesOther");
  raw.importWorktrees = form.get("importWorktrees") === "on";
  raw.pollIntervalSeconds = Math.round(pollMinutes * 60);
  raw.workCheckIntervalSeconds = Math.round(workMinutes * 60);
  raw.repoMode = repoMode;
  if (reposRoot) raw.reposRoot = reposRoot;
  raw.repoPaths = repoPaths;
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
  for (const r of listRepos({ ...cfg, repoMode, reposRoot: expandHome(reposRoot || cfg.reposRoot), repoPaths: repoPaths.map(expandHome) })) {
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
  if (raw.moveToInProgressOnApprove && !before.move) {
    notes.push("Moving tickets to In Progress needs Linear write access: run `linear-autopilot login --force` once.");
  }
  return { errors, notes };
}

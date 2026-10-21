import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "../config/config";
import type { Launcher } from "./types";
import { claudeCommand, fetchOrigin, run, worktreeForBranch, assertWorktree } from "./common";
import { adoptSupersetWorktree } from "./superset-host";
import { step } from "../app/steps";
import { log } from "../shared/log";

interface Workspace {
  id: string;
  projectId: string;
  type: string;
  branch: string;
  worktreePath: string;
  worktreeExists: boolean;
  archivedAt: string | null;
}

const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
const cli = (cfg: Config, args: string[], timeout = 30_000) => run([cfg.launch.supersetBin, ...args, "--local"], timeout);
const caches = new WeakMap<Config, { bin: string; expires: number; result: Promise<Workspace[]> }>();
const registrations = new WeakMap<Config, Map<string, Promise<string>>>();

/** Share one short-lived lookup across dashboard links; mutations always get a fresh inventory. */
async function workspaces(cfg: Config, fresh = false): Promise<Workspace[]> {
  const cached = caches.get(cfg);
  if (!fresh && cached?.bin === cfg.launch.supersetBin && cached.expires > Date.now()) return cached.result;
  const result = cli(cfg, ["workspaces", "list", "--json"], fresh ? 30_000 : 5_000).then((out) => {
    const rows = JSON.parse(out);
    if (!Array.isArray(rows)) throw new Error("Superset returned an invalid workspace list");
    return rows.filter((w): w is Workspace =>
      typeof w.id === "string" && typeof w.projectId === "string" && typeof w.worktreePath === "string" &&
      w.type === "worktree" && w.worktreeExists !== false && !w.archivedAt);
  });
  caches.set(cfg, { bin: cfg.launch.supersetBin, expires: Date.now() + 15_000, result });
  return result;
}

async function workspaceAt(cfg: Config, path: string, fresh = true): Promise<Workspace> {
  const matches = (await workspaces(cfg, fresh)).filter((w) => canonical(w.worktreePath) === canonical(path));
  if (matches.length !== 1) throw new Error(`Expected one Superset worktree at ${path}; found ${matches.length}. Import the worktree into Superset or resolve duplicate entries before retrying.`);
  return matches[0];
}

async function projectFor(cfg: Config, repoPath: string): Promise<string> {
  const pending = registrations.get(cfg) ?? new Map<string, Promise<string>>();
  registrations.set(cfg, pending);
  const key = JSON.stringify([cfg.launch.supersetBin, canonical(repoPath)]);
  const existing = pending.get(key);
  if (existing) return existing;
  // projects create is not idempotent; simultaneous ticket approvals must share registration.
  const result = ensureProject(cfg, repoPath);
  pending.set(key, result);
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}

async function ensureProject(cfg: Config, repoPath: string): Promise<string> {
  const find = async () => {
    const projects = JSON.parse(await cli(cfg, ["projects", "list", "--json"]));
    if (!Array.isArray(projects)) throw new Error("Superset returned an invalid project list");
    const matches = projects.filter((p) => typeof p.path === "string" && canonical(p.path) === canonical(repoPath));
    if (matches.length > 1) throw new Error(`More than one Superset project uses ${repoPath}; remove the duplicate project before retrying.`);
    const id = matches[0]?.id;
    if (matches.length && (typeof id !== "string" || !id)) throw new Error("Superset returned an invalid project ID");
    return id as string | undefined;
  };
  const existing = await find();
  if (existing) return existing;
  step(`Registering ${basename(repoPath)} with Superset…`);
  await cli(cfg, ["projects", "create", "--name", basename(repoPath), "--import", repoPath, "--json"], 60_000);
  const id = await find();
  if (!id) throw new Error(`Superset did not register ${repoPath}`);
  return id;
}

export function superset(cfg: Config): Launcher {
  return {
    name: "superset",
    async adoptWorktree(repoPath, path, branch) {
      await assertWorktree(repoPath, path, branch);
      const project = await projectFor(cfg, repoPath);
      const matches = (await workspaces(cfg, true)).filter((w) => canonical(w.worktreePath) === canonical(path));
      if (matches.length > 1 || matches.some((w) => w.projectId !== project || w.branch !== branch)) {
        throw new Error(`Superset has conflicting workspace entries for ${path}; resolve them before retrying`);
      }
      if (!matches.length) {
        step(`Registering the existing worktree in ${basename(repoPath)} with Superset…`);
        await adoptSupersetWorktree(cfg, project, path, branch);
        caches.delete(cfg);
      }
      const workspace = await workspaceAt(cfg, path);
      if (workspace.projectId !== project || workspace.branch !== branch) throw new Error(`Superset did not adopt ${path} on ${branch}`);
    },
    async ensureWorktree(repoPath, branch) {
      const existing = await worktreeForBranch(repoPath, branch);
      if (existing) {
        await this.adoptWorktree(repoPath, existing, branch);
        step(`Reusing the Superset worktree in ${basename(repoPath)}`);
        return existing;
      }
      const project = await projectFor(cfg, repoPath);
      if (cfg.launch.fetch) await fetchOrigin(repoPath);
      step(`Creating the worktree in ${basename(repoPath)} with Superset…`);
      const args = ["workspaces", "create", "--project", project, "--name", branch, "--branch", branch, "--skip-branch-prefix", "--json"];
      if (cfg.launch.base) args.push("--base-branch", cfg.launch.base);
      await cli(cfg, args, 330_000);
      caches.delete(cfg);
      const workspace = (await workspaces(cfg, true)).find((w) => w.projectId === project && w.branch === branch);
      const path = await worktreeForBranch(repoPath, branch);
      if (!workspace || workspace.projectId !== project || !path || canonical(workspace.worktreePath) !== canonical(path)) {
        throw new Error(`Superset did not create a worktree on ${branch} in ${repoPath}`);
      }
      return path;
    },
    async openSession(req) {
      const workspace = await workspaceAt(cfg, req.primaryPath);
      step("Opening a Claude terminal in Superset…");
      await cli(cfg, ["terminals", "create", "--workspace", workspace.id, "--cwd", req.primaryPath, "--command", claudeCommand(cfg, req), "--json"], 60_000);
      // Creating a terminal does not steal focus. Opening is a separate, optional action.
      if (!req.background) {
        await cli(cfg, ["workspaces", "open", workspace.id], 30_000).catch((err) =>
          log.warn("Claude started in Superset, but its window could not be opened; use the ticket's workspace link", err));
      }
      log.info(`launched claude in ${req.primaryPath} (Superset workspace ${workspace.id})`);
    },
    async removeWorktree(repoPath, worktreePath, branch) {
      const workspace = await workspaceAt(cfg, worktreePath);
      const path = await worktreeForBranch(repoPath, branch);
      if (!path || canonical(path) !== canonical(worktreePath)) throw new Error(`Refusing to archive a Superset workspace that no longer matches ${branch} in ${repoPath}`);
      // Autopilot checks for dirty/unpushed work before this call. Archive keeps the branch.
      await cli(cfg, ["workspaces", "archive", workspace.id, "--json"], 150_000);
      caches.delete(cfg);
      if (existsSync(worktreePath)) throw new Error(`Superset archived the workspace but its worktree still exists at ${worktreePath}`);
    },
    async link(path) {
      try {
        const workspace = await workspaceAt(cfg, path, false);
        return `superset://v2-workspace/${encodeURIComponent(workspace.id)}`;
      } catch {
        return null; // An unavailable Superset host must not break the dashboard.
      }
    },
  };
}

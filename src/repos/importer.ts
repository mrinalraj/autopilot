import { basename } from "node:path";
import type { RepoEntry } from "./catalog";
import { listWorktrees } from "../workspaces/launch";

/** A worktree whose branch (or folder) names a Linear ticket, e.g. fix-tab-eng-4821 or eng-6150. */
export interface FoundWorktree {
  identifier: string;
  repo: string;
  repoPath: string;
  path: string;
  branch: string;
}

/** The ticket identifier in a branch or folder name, for the given team keys (ENG, IT, …). */
export function ticketIdFrom(name: string, teamKeys: string[]): string | null {
  if (!teamKeys.length) return null;
  const keys = teamKeys.map((k) => k.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean).join("|");
  const m = name.match(new RegExp(`(?:^|[^A-Za-z0-9])(${keys})-(\\d+)(?![A-Za-z0-9])`, "i"));
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/** Every worktree across the catalog that maps to a ticket, grouped by identifier. */
export async function scanWorktrees(catalog: RepoEntry[], teamKeys: string[]): Promise<Map<string, FoundWorktree[]>> {
  const found = new Map<string, FoundWorktree[]>();
  for (const repo of catalog) {
    let worktrees: { path: string; branch: string | null }[] = [];
    try {
      worktrees = await listWorktrees(repo.path);
    } catch {
      continue; // not a usable repo right now
    }
    for (const w of worktrees) {
      const identifier = (w.branch && ticketIdFrom(w.branch, teamKeys)) || ticketIdFrom(basename(w.path), teamKeys);
      if (!identifier || !w.branch) continue;
      const list = found.get(identifier) ?? [];
      list.push({ identifier, repo: repo.name, repoPath: repo.path, path: w.path, branch: w.branch });
      found.set(identifier, list);
    }
  }
  return found;
}

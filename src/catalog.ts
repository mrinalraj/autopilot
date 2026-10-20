import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

export interface RepoEntry {
  name: string;
  path: string;
  description: string;
  /** Top-level files/dirs, to help the resolver match ticket wording to code. */
  topLevel: string[];
}

function deriveDescription(repoPath: string): string {
  const pkg = join(repoPath, "package.json");
  if (existsSync(pkg)) {
    try {
      const desc = JSON.parse(readFileSync(pkg, "utf8")).description;
      if (typeof desc === "string" && desc.trim()) return desc.trim();
    } catch {
      // fall through to README
    }
  }
  for (const name of ["README.md", "readme.md", "README"]) {
    const readme = join(repoPath, name);
    if (!existsSync(readme)) continue;
    const lines = readFileSync(readme, "utf8").split("\n").map((l) => l.trim());
    const heading = lines.find((l) => l.startsWith("# "))?.slice(2) ?? "";
    const para = lines.find((l) => l && !/^(#|>|!\[|\[!|```|<)/.test(l));
    return [heading, para].filter(Boolean).join(": ").slice(0, 200);
  }
  return "";
}

function topLevel(repoPath: string): string[] {
  return readdirSync(repoPath)
    .filter((n) => !n.startsWith("."))
    .sort()
    .slice(0, 40);
}

function discover(reposRoot: string): string[] {
  return readdirSync(reposRoot)
    .filter((n) => !n.startsWith("."))
    .filter((n) => {
      const p = join(reposRoot, n);
      return statSync(p).isDirectory() && existsSync(join(p, ".git"));
    })
    .sort();
}

/**
 * Repo catalog for every git repo directly under `reposRoot`. Derived descriptions are
 * cached in the state dir on first sight; `config.repos[name].description` always wins.
 */
export function loadCatalog(cfg: Config): RepoEntry[] {
  const cachePath = join(cfg.stateDir, "catalog.cache.json");
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  let dirty = false;

  const entries = discover(cfg.reposRoot)
    .filter((name) => !cfg.repos[name]?.exclude)
    .map((name) => {
      const path = join(cfg.reposRoot, name);
      if (!(name in cache)) {
        cache[name] = deriveDescription(path);
        dirty = true;
      }
      return { name, path, description: cfg.repos[name]?.description ?? cache[name], topLevel: topLevel(path) };
    });

  if (dirty) writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  return entries;
}

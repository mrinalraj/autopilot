import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "../config/config";

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

/** Git repos directly inside `root`. */
export function discover(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith("."))
    .filter((n) => {
      const p = join(root, n);
      try {
        return statSync(p).isDirectory() && existsSync(join(p, ".git"));
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The repos in play: every git repo directly inside the parent folders, plus the individual ones.
 * Named by folder; two with the same folder name get their parent's name prepended. Derived
 * descriptions are cached in the state dir; `config.repos[name].description` always wins.
 */
export function repoSources(cfg: Config): { name: string; path: string }[] {
  const paths: string[] = [];
  for (const root of cfg.repoRoots) if (existsSync(root)) for (const n of discover(root)) paths.push(join(root, n));
  for (const p of cfg.repoPaths) if (existsSync(join(p, ".git"))) paths.push(p);
  const seen = new Map<string, number>();
  return [...new Set(paths.map((p) => resolve(p)))].map((path) => {
    const base = basename(path);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { name: n === 1 ? base : `${basename(dirname(path))}-${base}`, path };
  });
}

export interface RepoSettings {
  name: string;
  path: string;
  derived: string;
  override: string;
  excluded: boolean;
}

export function listRepos(cfg: Config): RepoSettings[] {
  const cachePath = join(cfg.stateDir, "catalog.cache.json");
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  return repoSources(cfg).map(({ name, path }) => {
    return {
      name,
      path,
      derived: cache[name] ?? deriveDescription(path),
      override: cfg.repos[name]?.description ?? "",
      excluded: !!cfg.repos[name]?.exclude,
    };
  });
}

export function loadCatalog(cfg: Config): RepoEntry[] {
  const cachePath = join(cfg.stateDir, "catalog.cache.json");
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  let dirty = false;

  const entries = repoSources(cfg)
    .filter(({ name }) => !cfg.repos[name]?.exclude)
    .map(({ name, path }) => {
      if (!(name in cache)) {
        cache[name] = deriveDescription(path);
        dirty = true;
      }
      return { name, path, description: cfg.repos[name]?.description ?? cache[name], topLevel: topLevel(path) };
    });

  if (dirty) writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  return entries;
}

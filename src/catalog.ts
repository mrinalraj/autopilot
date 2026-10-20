import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
/** Every git repo under reposRoot, excluded ones included, with derived and overridden descriptions. */
/** The repos in play: discovered in the parent folder, or the explicit list (named by folder). */
export function repoSources(cfg: Config): { name: string; path: string }[] {
  if (cfg.repoMode === "list") {
    const seen = new Map<string, number>();
    return cfg.repoPaths
      .filter((p) => existsSync(join(p, ".git")))
      .map((path) => {
        const base = basename(path);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        // Two repos with the same folder name get the parent's name prepended to stay distinct.
        return { name: n === 1 ? base : `${basename(dirname(path))}-${base}`, path };
      });
  }
  if (!existsSync(cfg.reposRoot)) return [];
  return discover(cfg.reposRoot).map((name) => ({ name, path: join(cfg.reposRoot, name) }));
}

export function listRepos(cfg: Config): { name: string; path: string; derived: string; override: string; excluded: boolean }[] {
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

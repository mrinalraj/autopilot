import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { discover } from "./catalog";

const NOT_CODE = new Set(["Library", "Applications", "Pictures", "Music", "Movies", "Public", "Downloads"]);

/** Folders in your home (and a few usual spots) that hold git repos, most repos first. */
export function suggestFolders(home = homedir()): { path: string; repos: string[] }[] {
  const dirs = (d: string) => {
    try {
      return readdirSync(d).filter((n) => !n.startsWith(".")).map((n) => join(d, n)).filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };
  const candidates = new Set([...dirs(home).filter((d) => !NOT_CODE.has(basename(d))), join(home, "Documents", "GitHub"), join(home, "Developer")]);
  return [...candidates]
    .map((path) => ({ path, repos: discover(path) }))
    .filter((c) => c.repos.length)
    .sort((a, b) => b.repos.length - a.repos.length)
    .slice(0, 8);
}

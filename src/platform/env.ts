import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config";
import { keychainGet } from "./keychain";

/**
 * launchd and `brew services` start us with a minimal PATH. Put user and Homebrew bins first so
 * `claude`, `gh`, `terminal-notifier` and Homebrew's git resolve as in a terminal (Homebrew's git
 * matters: its credential helper is the one trusted for github.com in the Keychain).
 */
export function preparePath() {
  const home = homedir();
  const preferred = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".superset", "bin"),
    join(home, "superset", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  const system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const head = preferred.filter((d) => !current.includes(d));
  const tail = system.filter((d) => !current.includes(d));
  process.env.PATH = [...head, ...current, ...tail].join(":");
}

/** ANTHROPIC_API_KEY for llm.provider "api": from the environment, else the Keychain. */
export async function prepareSecrets(cfg: Config) {
  if (cfg.llm.provider !== "api" || process.env.ANTHROPIC_API_KEY) return;
  const key = await keychainGet("ANTHROPIC_API_KEY");
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config";
import { run } from "./common";

/** The CLI lacks a setup-free import command. Use Superset's local adoption procedure. */
export async function adoptSupersetWorktree(cfg: Config, projectId: string, worktreePath: string, branch: string): Promise<void> {
  const account = JSON.parse(await run([cfg.launch.supersetBin, "auth", "whoami", "--json"], 30_000));
  if (typeof account.organizationId !== "string" || !/^[a-zA-Z0-9-]+$/.test(account.organizationId)) {
    throw new Error("Superset did not identify the active organization");
  }
  const home = process.env.SUPERSET_HOME_DIR || join(homedir(), ".superset");
  let manifest: { endpoint?: string; authToken?: string };
  try {
    manifest = JSON.parse(readFileSync(join(home, "host", account.organizationId, "manifest.json"), "utf8"));
  } catch {
    throw new Error("Cannot find Superset's local host; open Superset and sign in before switching worktrees");
  }
  const endpoint = new URL(manifest.endpoint ?? "");
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || typeof manifest.authToken !== "string" || !manifest.authToken) {
    throw new Error("Superset's host manifest must identify an authenticated local endpoint");
  }
  // Never write the host token to disk or logs, and never forward it through a redirect.
  const response = await fetch(`${endpoint.origin}/trpc/workspaceCreation.adopt`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${manifest.authToken}` },
    body: JSON.stringify({ json: { projectId, worktreePath, branch, workspaceName: branch } }),
  });
  const result = await response.json() as { result?: { data?: { json?: { workspace?: { id?: string } } } }; error?: { json?: { message?: string } } };
  if (!response.ok || !result.result?.data?.json?.workspace?.id) {
    throw new Error(`Superset could not adopt the existing worktree: ${result.error?.json?.message?.slice(0, 500) ?? `host returned ${response.status}`}. Update Superset or import this worktree in its app, then retry.`);
  }
}

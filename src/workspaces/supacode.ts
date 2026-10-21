import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config/config";
import { worktreeId, pathFromId } from "../domain/worktree";
import { log } from "../shared/log";
import { step } from "../app/steps";
import { run, claudeCommand, worktreeForBranch, fetchOrigin, assertWorktree } from "./common";
import type { Launcher } from "./types";

const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

/* ---------- Supacode: worktree and Claude tab in the app ---------- */

export function supacode(cfg: Config): Launcher {
  const sc = cfg.launch.supacodeBin;
  const useCli = () => existsSync(sc);
  return {
    name: "supacode",
    async adoptWorktree(repoPath, path, branch) {
      await assertWorktree(repoPath, path, branch);
      if (useCli() && !(await run([sc, "repo", "list"], 30_000)).split("\n").includes(worktreeId(repoPath))) {
        await run([sc, "repo", "open", repoPath], 60_000);
      }
    },
    async ensureWorktree(repoPath, branch, background) {
      const existing = await worktreeForBranch(repoPath, branch);
      if (existing) {
        await this.adoptWorktree(repoPath, existing, branch);
        step(`Reusing the existing worktree in ${basename(repoPath)}`);
        return existing;
      }
      if (cfg.launch.fetch) await fetchOrigin(repoPath);
      const repoId = worktreeId(repoPath);

      if (useCli()) {
        if (!(await run([sc, "repo", "list"], 30_000)).split("\n").includes(repoId)) {
          log.info(`registering ${repoPath} with Supacode`);
          await run([sc, "repo", "open", repoPath], 60_000);
        }
        step(`Creating the worktree in ${basename(repoPath)} with Supacode (its hooks run now)…`);
        const args = [sc, "repo", "worktree-new", "-r", repoId, "--branch", branch, "--timeout", "300"];
        if (cfg.launch.base) args.push("--base", cfg.launch.base);
        if (background) args.push("--background");
        const id = lastLine(await run(args, 330_000));
        if (!id) throw new Error(`supacode repo worktree-new printed no worktree ID for ${repoPath}`);
        return pathFromId(id);
      }

      // Deeplink fallback when the CLI binary is missing.
      const q = new URLSearchParams({ branch });
      if (cfg.launch.base) q.set("base", cfg.launch.base);
      if (background) q.set("background", "true");
      await run(["open", `supacode://repo/${repoId}/worktree/new?${q}`], 30_000);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await Bun.sleep(2_000);
        const path = await worktreeForBranch(repoPath, branch);
        if (path) return path;
      }
      throw new Error(`Supacode did not create the worktree for ${repoPath} within 180s (deeplink)`);
    },
    async openSession(req) {
      const command = claudeCommand(cfg, req);
      const title = `${req.identifier} claude`;
      const id = worktreeId(req.primaryPath);
      if (useCli()) {
        step("Opening a Claude tab in Supacode…");
        const args = [sc, "tab", "new", "-w", id, "--title", title, "-i", command];
        if (req.background) args.push("--background");
        const tabId = lastLine(await run(args, 60_000));
        log.info(`launched claude in ${req.primaryPath} (tab ${tabId})`);
        return;
      }
      const q = new URLSearchParams({ input: command, title });
      await run(["open", `supacode://worktree/${id}/tab/new?${q}`], 30_000);
    },
    // Supacode also closes the worktree's terminals, including the Claude session.
    async removeWorktree(_repoPath, worktreePath) {
      const id = worktreeId(worktreePath);
      if (useCli()) await run([sc, "worktree", "delete", "-w", id, "--background", "--timeout", "120"], 150_000);
      else await run(["open", `supacode://worktree/${id}/delete?background=true`], 30_000);
    },
    link: (path) => `supacode://worktree/${worktreeId(path)}`,
  };
}

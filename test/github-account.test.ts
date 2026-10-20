import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { Autopilot } from "../src/autopilot";
import { supacodeId } from "../src/launch";
import type { LLM } from "../src/llm";
import type { Tracker } from "../src/tracker";

const dir = mkdtempSync(join(tmpdir(), "autopilot-gh-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a different GitHub account re-checks settled tickets too", async () => {
  process.env.AUTOPILOT_NOTIFY = "off";
  const repo = join(dir, "repos", "api");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repo]);
  const cfg = { ...loadConfig("/nonexistent"), reposRoot: join(dir, "repos"), stateDir: join(dir, "state"), githubUser: "work-account" };
  const store = new Store(cfg.stateDir);
  store.upsertIssue({
    linear_id: "x", identifier: "ENG-1", title: "Done thing", url: "u", brief_path: join(dir, "ENG-1.md"), repo: "api", repo_path: repo,
    branch: "done-thing-eng-1", confidence: 1, resolve_reason: "", status: "running", error: null,
    worktree_id: supacodeId(join(dir, "gone")), ticket_json: "{}", explainer_json: "{}", extra_repos_json: "[]",
  });
  // Settled: its only PR is merged, so routine checks skip it.
  const merged = JSON.stringify([{ repo: "api", missing: true, pr: { number: 7, url: "u", state: "MERGED", isDraft: false, title: "t" } }]);
  store.setWork("x", merged, false);
  const tracker = { kind: "linear", label: "Linear", issueState: async () => null } as unknown as Tracker;
  const ap = new Autopilot(cfg, store, tracker, {} as LLM);

  await ap.refreshWork(); // first run records the account
  expect(store.getMeta("github_account")).toBe("work-account");
  expect(store.getIssue("x")!.work_json).toBe(merged);

  await ap.refreshWork(); // same account: still skipped
  expect(store.getIssue("x")!.work_json).toBe(merged);

  cfg.githubUser = "personal-account";
  await ap.refreshWork(); // the new account can't see PR #7 here, so the ticket is re-checked
  expect(store.getIssue("x")!.work_json).not.toBe(merged);
  expect(store.getMeta("github_account")).toBe("personal-account");
});

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { Store } from "../../src/storage/db";
import { Autopilot } from "../../src/app/autopilot";
import type { Tracker } from "../../src/trackers/tracker";
import type { LLM } from "../../src/triage/llm";
import { dashboardData } from "../../src/web/presenters/dashboard";
import { stateVersion } from "../../src/web/state";
import type { WebContext } from "../../src/web/context";
import { worktreeId } from "../../src/domain/worktree";
import { issue, work } from "../fixtures/issues";

const dir = mkdtempSync(join(tmpdir(), "autopilot-presenter-"));
const cfg = { ...loadConfig("/nonexistent"), stateDir: dir };
const store = new Store(dir);
const ap = new Autopilot(cfg, store, { kind: "linear", label: "Linear" } as Tracker, {} as LLM);
const ctx: WebContext = { ap, csrf: "test-token", bootId: "boot", configPath: join(dir, "config.json"), gh: () => ({ installed: false, accounts: [] }) };
afterAll(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test("an empty dashboard does not scan the catalog", async () => {
  ap.catalog = () => { throw new Error("No catalog should be loaded for an empty dashboard"); };
  const data = await dashboardData(ctx);
  expect(data.catalog).toEqual([]);
  expect(data.queue).toEqual([]);
  expect(data.inProgress).toEqual([]);
  expect(data.prsOpen).toBe(0);
});

test("presenter groups phases and resolves links once, without exposing app services", async () => {
  let scans = 0;
  ap.catalog = () => { scans++; return [{ name: "api", path: "/code/api", description: "API", topLevel: [] }]; };
  for (const row of [
    issue(),
    issue({ linear_id: "launch", identifier: "ENG-2", status: "approved" }),
    issue({ linear_id: "progress", identifier: "ENG-3", status: "running" }),
    issue({ linear_id: "review", identifier: "ENG-4", status: "running", worktree_id: worktreeId("/work/api"), work_json: JSON.stringify([
      work({ pr: { number: 4, url: "https://example.test/pr/4", state: "OPEN", isDraft: false, title: "Fix" } }),
    ]) }),
    issue({ linear_id: "done", identifier: "ENG-5", status: "running", linear_state_type: "completed" }),
    issue({ linear_id: "rejected", identifier: "ENG-6", status: "rejected" }),
  ]) {
    store.upsertIssue(row);
    store.updateIssue(row.linear_id, { launcher: row.launcher, linear_state: row.linear_state, linear_state_type: row.linear_state_type });
    if (row.work_json) store.setWork(row.linear_id, row.work_json, false);
  }
  const data = await dashboardData(ctx);
  expect(scans).toBe(1);
  expect([data.queue, data.launching, data.inProgress, data.inReview, data.completed, data.rejected].map((rows) => rows.map((row) => row.identifier)))
    .toEqual([["ENG-1"], ["ENG-2"], ["ENG-3"], ["ENG-4"], ["ENG-5"], ["ENG-6"]]);
  expect(data.prsOpen).toBe(1);
  expect(data.worktreeLinks.get("review")?.get("/work/api")).toBe(`supacode://worktree/${worktreeId("/work/api")}`);
  expect(data.cfg).not.toBe(ap.cfg);
  expect(data).not.toHaveProperty("ap");
  expect(data).not.toHaveProperty("store");
  expect(Object.values(data).some((value) => typeof value === "function")).toBe(false);
});

test("changing the launcher refreshes open pages and replaces legacy deep links before migration finishes", async () => {
  const before = stateVersion(ap);
  cfg.launch.launcher = "cursor";
  const data = await dashboardData(ctx);
  expect(stateVersion(ap)).not.toBe(before);
  expect(data.worktreeLinks.get("review")?.get("/work/api")).toBe("cursor://file/work/api");
  expect(data.canResendPrompt).toBe(true);
  expect(store.getIssue("review")?.launcher).toBe("supacode"); // old metadata cannot override Settings
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autopilot } from "../../src/app/autopilot";
import { launchSteps } from "../../src/app/steps";
import { loadConfig } from "../../src/config/config";
import { Store } from "../../src/storage/db";
import { writeBrief } from "../../src/triage/brief";
import type { IssueRow } from "../../src/domain/issues";
import type { LLM } from "../../src/triage/llm";
import type { Tracker } from "../../src/trackers/tracker";
import { issue, work } from "../fixtures/issues";

const cleanup: (() => void)[] = [];
afterEach(() => { launchSteps.clear(); for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(patch: Partial<IssueRow> = {}) {
  const root = mkdtempSync(join(tmpdir(), "autopilot-edit-triage-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cfg = loadConfig("/nonexistent");
  Object.assign(cfg, { stateDir: join(root, "state"), briefsDir: join(root, "briefs") });
  const store = new Store(cfg.stateDir);
  cleanup.push(() => store.db.close());
  store.upsertIssue(issue({ brief_path: join(cfg.briefsDir, "ENG-1.md"), ...patch }));
  const row = () => store.getIssueByIdentifier("ENG-1")!;
  writeBrief(row());
  // Any accidental tracker or LLM call during an edit fails.
  const ap = new Autopilot(cfg, store, {} as Tracker, {} as LLM);
  const edits = () => ({ expected: row().explainer_json, summary: "  Clarified requirement\nKeep compatibility.  ", approach: "  Update API\nAdd a regression test.  ",
    likelyAreas: " src/api.ts\r\n\r\nsrc/api.ts\r\n test/api.test.ts ", size: "M" });
  return { root, cfg, store, ap, row, edits };
}

test("editing triage persists all fields and refreshes the brief without changing routing or workflow", () => {
  const f = fixture();
  const before = f.row();
  expect(f.ap.saveTriage("ENG-1", f.edits()).ok).toBe(true);
  const after = f.row();
  expect(JSON.parse(after.explainer_json)).toEqual({ summary: "Clarified requirement\nKeep compatibility.", approach: "Update API\nAdd a regression test.",
    likely_areas: ["src/api.ts", "test/api.test.ts"], size: "M" });
  const { explainer_json: oldExplainer, updated_at: oldTime, ...oldState } = before;
  const { explainer_json: newExplainer, updated_at: newTime, ...newState } = after;
  expect(newState).toEqual(oldState);
  const brief = readFileSync(after.brief_path, "utf8");
  expect(brief).toContain("Clarified requirement\nKeep compatibility.");
  expect(brief).toContain("Update API\nAdd a regression test.");
  expect(brief).toContain("`test/api.test.ts`");
  expect(statSync(after.brief_path).mode & 0o222).toBe(0);
  expect(readdirSync(f.cfg.briefsDir)).toEqual(["ENG-1.md"]);
  const reopened = new Store(f.cfg.stateDir);
  try { expect(reopened.getIssueByIdentifier("ENG-1")?.explainer_json).toBe(after.explainer_json); }
  finally { reopened.db.close(); }
  writeBrief(after); // subsequent launch/resend projection retains the saved text
  expect(readFileSync(after.brief_path, "utf8")).toBe(brief);
});

test("editing existing or imported tickets preserves worktrees, PR tracking and triage eligibility", () => {
  for (const triage_source of ["automatic", "manual", null] as const) {
    const f = fixture({ status: "running", triage_source, worktree_id: "%2Fwork%2Fapi%2F", extra_repos_json: JSON.stringify([
      { repo: "web", repo_path: "/code/web", branch: "other-branch", launcher: "superset", worktree_id: "%2Fwork%2Fweb%2F", reason: "UI" },
    ]) });
    f.store.setWork(f.row().linear_id, JSON.stringify([work({ dirtyFiles: 2 })]), true);
    const before = f.row();
    expect(f.ap.saveTriage("ENG-1", f.edits()).ok).toBe(true);
    for (const key of ["status", "triage_source", "worktree_id", "extra_repos_json", "work_json", "launcher", "branch", "ticket_json"] as const) {
      expect(f.row()[key]).toEqual(before[key]);
    }
  }
});

test("invalid or stale edits leave the database and brief unchanged", () => {
  const f = fixture();
  const before = f.row(), brief = readFileSync(before.brief_path, "utf8");
  for (const patch of [{ summary: "  " }, { summary: "x".repeat(10_001) }, { approach: "x".repeat(20_001) },
    { likelyAreas: "x".repeat(10_001) }, { likelyAreas: Array.from({ length: 101 }, (_, i) => `file-${i}`).join("\n") },
    { size: "XL" }, { size: "" }, { expected: "" }]) {
    expect(f.ap.saveTriage("ENG-1", { ...f.edits(), ...patch }).ok).toBe(false);
    expect(f.row()).toEqual(before);
    expect(readFileSync(before.brief_path, "utf8")).toBe(brief);
  }
  const stale = f.edits();
  expect(f.ap.saveTriage("ENG-1", { ...stale, summary: "First editor's saved text" }).ok).toBe(true);
  expect(f.ap.saveTriage("ENG-1", stale)).toMatchObject({ ok: false, error: expect.stringContaining("changed since") });
  expect(JSON.parse(f.row().explainer_json).summary).toBe("First editor's saved text");
});

test("editing refuses an in-flight action but tolerates unrelated work refreshes", () => {
  const f = fixture();
  const edits = f.edits();
  launchSteps.set("ENG-1", "Opening session…");
  expect(f.ap.saveTriage("ENG-1", edits).ok).toBe(false);
  launchSteps.clear();
  f.ap.progress.current = "ENG-1";
  expect(f.ap.saveTriage("ENG-1", edits).ok).toBe(false);
  f.ap.progress.current = null;
  f.store.updateIssue(f.row().linear_id, { status: "approved" });
  expect(f.ap.saveTriage("ENG-1", edits).ok).toBe(false);
  f.store.updateIssue(f.row().linear_id, { status: "pending", linear_state: "New status" });
  f.store.setWork(f.row().linear_id, JSON.stringify([work()]), true);
  expect(f.ap.saveTriage("ENG-1", edits).ok).toBe(true);
  expect(f.ap.saveTriage("ENG-404", edits).ok).toBe(false);
});

test("a brief write failure rolls back triage edits and cleans up the temporary file", () => {
  const f = fixture();
  const blocked = join(f.cfg.briefsDir, "blocked");
  mkdirSync(blocked);
  f.store.db.query("UPDATE issues SET brief_path = ? WHERE identifier = ?").run(blocked, "ENG-1");
  const before = f.row();
  expect(f.ap.saveTriage("ENG-1", f.edits()).ok).toBe(false);
  expect(f.row()).toEqual(before);
  expect(readdirSync(f.cfg.briefsDir).sort()).toEqual(["ENG-1.md", "blocked"]);
});

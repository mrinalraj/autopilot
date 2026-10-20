import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWork, isSettled, overallStage, stage, type RepoWork, type WorkStatus } from "../src/work";

const dir = mkdtempSync(join(tmpdir(), "autopilot-work-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

const base: WorkStatus = {
  checkedAt: "", worktreePath: "", missing: false, commitsAhead: 0, unpushed: 0, dirtyFiles: 0, lastCommitAt: null, pr: null, error: null,
};
const pr = (state: "OPEN" | "MERGED" | "CLOSED", isDraft = false) => ({ number: 1, url: "u", state, isDraft, title: "t" });

test("stage reflects PR first, then local work", () => {
  expect(stage(base)).toBe("working");
  expect(stage({ ...base, commitsAhead: 2 })).toBe("committed");
  expect(stage({ ...base, pr: pr("OPEN", true) })).toBe("draft");
  expect(stage({ ...base, pr: pr("OPEN") })).toBe("pr-open");
  expect(stage({ ...base, pr: pr("MERGED") })).toBe("merged");
  expect(stage({ ...base, missing: true })).toBe("missing");
});

test("overall stage across repos ignores repos the session never touched", () => {
  const rw = (repo: string, w: Partial<WorkStatus>): RepoWork => ({ ...base, repo, ...w });
  const untouched = rw("web", {});
  expect(overallStage([rw("api", { pr: pr("OPEN") }), untouched])).toBe("pr-open");
  expect(overallStage([rw("api", { pr: pr("MERGED") }), untouched])).toBe("merged");
  expect(isSettled([rw("api", { pr: pr("MERGED") }), untouched])).toBe(true);
  // One PR merged but the other repo still has unpushed work: not done.
  expect(overallStage([rw("api", { pr: pr("MERGED") }), rw("web", { commitsAhead: 2 })])).toBe("committed");
  expect(isSettled([rw("api", { pr: pr("MERGED") }), rw("web", { pr: pr("OPEN") })])).toBe(false);
  expect(overallStage([rw("api", { pr: pr("OPEN", true) }), rw("web", { commitsAhead: 1 })])).toBe("draft");
  expect(overallStage([untouched])).toBe("working");
});

test("counts commits ahead of origin's base and uncommitted files", async () => {
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "work");
  writeFileSync(join(dir, "wip.txt"), "x");

  const w = await checkWork(encodeURIComponent(dir + "/"), dir, "some-branch-eng-1");
  expect(w.missing).toBe(false);
  expect(w.worktreePath).toBe(dir);
  expect(w.commitsAhead).toBe(1);
  expect(w.dirtyFiles).toBe(1);
  expect(w.lastCommitAt).not.toBeNull();
  expect(w.pr).toBeNull(); // no GitHub remote here, so gh reports an error instead
});

test("a removed worktree is reported as missing", async () => {
  const w = await checkWork(encodeURIComponent("/nonexistent/wt/x/"), dir, "b-eng-1");
  expect(w.missing).toBe(true);
  expect(stage(w)).toBe("missing");
});

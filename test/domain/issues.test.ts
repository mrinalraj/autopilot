import { expect, test } from "bun:test";
import { phaseOf, workOf, worktreesOf, issueExtras } from "../../src/domain/issues";
import { worktreeId, pathFromId } from "../../src/domain/worktree";
import { issue, work } from "../fixtures/issues";

test("legacy work JSON and current multi-repo snapshots normalize without I/O", () => {
  const { repo: _, ...legacy } = work();
  expect(workOf(issue({ work_json: JSON.stringify(legacy) }))).toEqual([work()]);
  const multi = [work(), work({ repo: "web" })];
  expect(workOf(issue({ work_json: JSON.stringify(multi) }))).toEqual(multi);
  expect(workOf(issue())).toBeNull();
});

test("ticket phase is a shared rule independent of the view and store", () => {
  expect(phaseOf(issue(), null)).toBe("in-progress");
  expect(phaseOf(issue({ linear_state: "In review" }), null)).toBe("in-review");
  const open = work({ pr: { number: 1, url: "https://example.test/1", state: "OPEN", isDraft: false, title: "Fix" } });
  expect(phaseOf(issue(), [open])).toBe("in-review");
  expect(phaseOf(issue({ linear_state_type: "completed" }), [open])).toBe("completed");
  expect(phaseOf(issue(), [{ ...open, pr: { ...open.pr!, state: "MERGED" } }])).toBe("completed");
});

test("worktree identities preserve spaces and collect primary and secondary repos", () => {
  const primary = worktreeId("/code/my repo");
  expect(pathFromId(primary)).toBe("/code/my repo");
  const extra = { repo: "web", repo_path: "/code/web", reason: "UI", worktree_id: worktreeId("/work/web") };
  const row = issue({ worktree_id: primary, extra_repos_json: JSON.stringify([extra]) });
  expect(issueExtras(row)).toEqual([extra]);
  expect(worktreesOf(row)).toEqual([
    { repo: "api", repoPath: "/code/api", worktreeId: primary },
    { repo: "web", repoPath: "/code/web", worktreeId: extra.worktree_id },
  ]);
  expect(worktreesOf(issue())).toEqual([]);
});

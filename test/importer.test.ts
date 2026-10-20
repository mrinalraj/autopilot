import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { Autopilot, phaseOf } from "../src/autopilot";
import { ticketIdFrom } from "../src/importer";
import { launcherFor } from "../src/launch";
import type { LinearClient, LinearIssue } from "../src/linear";
import type { LLM } from "../src/llm";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-import-")));
const reposRoot = join(dir, "repos");
const ME = "me";
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stderr: "pipe" });

const issue = (id: string, identifier: string, stateName: string, stateType: string): LinearIssue => ({
  id, identifier, title: `Ticket ${identifier}`, description: `Body of ${identifier}`, url: `https://linear.app/x/${identifier}`,
  updatedAt: new Date().toISOString(), gitBranchName: `${identifier.toLowerCase()}-from-linear`, assigneeId: ME,
  state: { name: stateName, type: stateType }, team: { id: "t", key: "ENG", name: "Eng" }, project: null, labels: [], attachments: [], comments: [],
});
const issues = [issue("u42", "ENG-42", "In Review", "started"), issue("u50", "ENG-50", "In Development", "started")];
const linear = {
  me: async () => ({ id: ME, name: "Me", teams: [{ id: "t", name: "Eng", key: "ENG" }] }),
  issue: async (id: string) => issues.find((i) => i.id === id || i.identifier === id) ?? null,
  issueState: async (id: string) => issues.find((i) => i.id === id)?.state ?? null,
  mineInStates: async (states: string[]) =>
    issues.filter((i) => states.includes(i.state.name)).map((i) => ({ id: i.id, identifier: i.identifier, assigneeId: ME, stateName: i.state.name, stateType: i.state.type })),
};
const llm: LLM = { json: async () => { throw new Error("imports must not call the LLM"); } };
let cfg: ReturnType<typeof loadConfig>;
let store: Store;
let ap: Autopilot;

beforeAll(() => {
  process.env.AUTOPILOT_NOTIFY = "off";
  for (const name of ["api", "web"]) {
    const repo = join(reposRoot, name);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  }
  git(join(reposRoot, "api"), "worktree", "add", "-q", "-b", "fix-thing-eng-42", join(dir, "wt", "api", "fix-thing-eng-42"));
  git(join(reposRoot, "web"), "worktree", "add", "-q", "-b", "ENG-42", join(dir, "wt", "web", "eng-42"));
  git(join(reposRoot, "api"), "worktree", "add", "-q", "-b", "random-work", join(dir, "wt", "api", "random-work"));
  const base = loadConfig("/nonexistent");
  cfg = {
    ...base, reposRoot, stateDir: join(dir, "state"), briefsDir: join(dir, "state", "briefs"),
    importStates: ["In Development"], importWorktrees: true,
    launch: { ...base.launch, supacodeBin: "/nonexistent", fetch: false, base: "main", terminal: "none", worktreesDir: join(dir, "made") },
  };
  store = new Store(cfg.stateDir);
  ap = new Autopilot(cfg, store, linear as unknown as LinearClient, llm);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("ticket numbers are found in branch and folder names for known team keys only", () => {
  expect(ticketIdFrom("billing-page-shows-wrong-total-eng-4821", ["ENG", "IT"])).toBe("ENG-4821");
  expect(ticketIdFrom("eng-5310-search-filters", ["ENG"])).toBe("ENG-5310");
  expect(ticketIdFrom("export-csv-timeout-ENG-3907", ["ENG"])).toBe("ENG-3907");
  expect(ticketIdFrom("it-12", ["ENG", "IT"])).toBe("IT-12");
  expect(ticketIdFrom("ai-accuracy-fixes", ["ENG"])).toBeNull();
  expect(ticketIdFrom("golang-1", ["ENG"])).toBeNull();
  expect(ticketIdFrom("eng-12345x", ["ENG"])).toBeNull();
});

test("imports worktree tickets (grouped across repos) and In Development tickets, without triage", async () => {
  expect((await ap.importExisting()).sort()).toEqual(["ENG-42", "ENG-50"]);

  const a = store.getIssueByIdentifier("ENG-42")!;
  expect(a.status).toBe("running");
  expect([a.repo, Store.extras(a).map((e) => e.repo)]).toEqual(["api", ["web"]]);
  expect(a.branch).toBe("fix-thing-eng-42");
  expect(a.launcher).toBe("git");
  expect(Autopilot.work(a)?.map((w) => w.repo)).toEqual(["api", "web"]);
  expect(phaseOf(a, Autopilot.work(a))).toBe("in-review");

  const b = store.getIssueByIdentifier("ENG-50")!;
  expect([b.worktree_id, b.repo, b.branch]).toEqual([null, "", "eng-50-from-linear"]);
  expect(phaseOf(b, Autopilot.work(b))).toBe("in-progress");

  expect(await ap.importExisting()).toEqual([]); // nothing twice
});

test("configured ticket prefixes replace the Linear team keys for matching", async () => {
  git(join(reposRoot, "web"), "worktree", "add", "-q", "-b", "ops-5-cleanup", join(dir, "wt", "web", "ops-5"));
  issues.push(issue("u5", "OPS-5", "Todo", "unstarted")); // not an importStates status: only the worktree can bring it in
  expect(await ap.importExisting()).toEqual([]); // OPS isn't one of my team keys
  cfg.ticketPrefixes = ["OPS"];
  expect(await ap.importExisting()).toEqual(["OPS-5"]);
  expect(store.getIssueByIdentifier("OPS-5")!.repo).toBe("web");
  cfg.ticketPrefixes = [];
});

test("Linear status changes move a ticket between phases", async () => {
  issues[0].state = { name: "Done", type: "completed" };
  await ap.refreshWork("u42");
  const a = store.getIssueByIdentifier("ENG-42")!;
  expect(a.linear_state).toBe("Done");
  expect(phaseOf(a, Autopilot.work(a))).toBe("completed");
});

test("git launcher creates, reuses and removes worktrees in the configured folder", async () => {
  const l = launcherFor(cfg, "git");
  const repo = join(reposRoot, "api");
  const path = await l.ensureWorktree(repo, "new-work-eng-77", false);
  expect(path).toBe(join(dir, "made", "api", "new-work-eng-77"));
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(await l.ensureWorktree(repo, "new-work-eng-77", false)).toBe(path); // reused
  await l.openSession({ identifier: "ENG-77", primaryPath: path, otherPaths: [], prompt: "p", addDirs: [], background: true }); // terminal "none"
  await l.removeWorktree(repo, path, "new-work-eng-77", false);
  expect(existsSync(path)).toBe(false);
});

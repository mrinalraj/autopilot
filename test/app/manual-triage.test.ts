import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autopilot, phaseOf } from "../../src/app/autopilot";
import { launchSteps } from "../../src/app/steps";
import { loadConfig } from "../../src/config/config";
import { needsTriage } from "../../src/domain/issues";
import { worktreeId } from "../../src/domain/worktree";
import { Store } from "../../src/storage/db";
import type { Tracker, TrackerIssue } from "../../src/trackers/tracker";
import type { JsonRequest, LLM } from "../../src/triage/llm";
import { startWeb } from "../../src/web/server";
import { issue as rowFixture, work } from "../fixtures/issues";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-manual-triage-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig("/nonexistent");
  Object.assign(cfg, { port: 0, onboarded: true, repoRoots: [join(dir, "repos")], stateDir: join(dir, "state"), briefsDir: join(dir, "briefs"),
    importWorktrees: false, importStates: ["In Development"], pickupStates: ["Ready for Development"] });
  Object.assign(cfg.launch, { launcher: "superset", supersetBin: "/nonexistent/superset", supacodeBin: "/nonexistent/supacode" });
  for (const name of ["api", "web"]) {
    mkdirSync(join(dir, "repos", name), { recursive: true });
    const git = Bun.spawnSync(["git", "init", "-q", join(dir, "repos", name)]);
    if (git.exitCode) throw new Error("fixture git init failed");
  }
  const ticket: TrackerIssue = {
    id: "ticket-1", identifier: "ENG-1", title: "Fix widget", description: "Initial description", url: "https://example.test/ENG-1",
    updatedAt: new Date().toISOString(), gitBranchName: null, assigneeId: "me", state: { name: "In Development", type: "started" },
    team: { id: "team", key: "ENG", name: "Engineering" }, project: null, labels: [], attachments: [], comments: [],
  };
  const control = { missing: false, fail: false, gate: null as Promise<void> | null };
  const ref = () => ({ id: ticket.id, identifier: ticket.identifier, assigneeId: ticket.assigneeId, stateName: ticket.state.name, stateType: ticket.state.type });
  const tracker = {
    kind: "linear", label: "Linear",
    me: async () => ({ id: "me", name: "Me", teams: [ticket.team] }), viewer: async () => ({ id: "me", name: "Me" }),
    issue: async () => control.missing ? null : structuredClone(ticket), issueState: async () => ({ ...ticket.state }),
    mineInStates: async (states: string[]) => states.includes(ticket.state.name) ? [ref()] : [],
    assignedToMe: async () => ticket.assigneeId === "me" ? [ref()] : [], updatedSince: async () => [ref()],
  } as unknown as Tracker;
  const requests: JsonRequest[] = [];
  const llm: LLM = { async json<T>(req: JsonRequest): Promise<T> {
    requests.push(req);
    await control.gate;
    if ("repo" in (req.schema.properties as object)) {
      return { repo: "web", confidence: 0.85, branch: "Fix widget", reason: "UI change", additional_repos: [{ repo: "api", reason: "API change" }] } as T;
    }
    if (control.fail) throw new Error("LLM unavailable");
    return { summary: "Fix the widget", approach: "Update the renderer", likely_areas: ["src/widget.ts"], size: "S" } as T;
  } };
  const store = new Store(cfg.stateDir);
  cleanup.push(() => store.db.close());
  const ap = new Autopilot(cfg, store, tracker, llm);
  await ap.importExisting();
  expect(requests).toHaveLength(0);
  return { dir, cfg, ticket, control, requests, tracker, llm, store, ap, row: () => store.getIssue(ticket.id)! };
}

async function finished() {
  const deadline = Date.now() + 5000;
  while (launchSteps.has("ENG-1")) {
    if (Date.now() > deadline) throw new Error("triage did not finish");
    await Bun.sleep(5);
  }
}

test("manual triage refreshes the ticket, prepares approval, and survives polling and restart outside pickup states", async () => {
  const f = await fixture();
  const before = f.row();
  expect(needsTriage(before)).toBe(true);
  f.ticket.description = "Latest description";
  f.ticket.comments = [{ author: "PM", createdAt: "2026-01-01", body: "Latest comment" }];
  let release!: () => void;
  f.control.gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    expect(f.ap.startTriage("ENG-1")).toEqual({ ok: true });
    expect(launchSteps.has("ENG-1")).toBe(true);
    expect(f.ap.startTriage("ENG-1").ok).toBe(false);
    expect((await f.ap.eraseAll()).ok).toBe(false);
    expect(f.row()).toEqual(before);
  } finally { release(); }
  await finished();
  expect(f.requests).toHaveLength(2);
  expect(f.requests.every((r) => r.prompt.includes("Latest description") && r.prompt.includes("Latest comment"))).toBe(true);
  expect(f.row()).toMatchObject({ status: "pending", repo: "web", branch: "fix-widget-eng-1", triage_source: "manual", launcher: null,
    confidence: 0.85, worktree_id: null, created_at: before.created_at });
  expect(Store.extras(f.row())).toEqual([{ repo: "api", repo_path: join(f.dir, "repos", "api"), reason: "API change", worktree_id: null }]);
  expect(readFileSync(f.row().brief_path, "utf8")).toContain("Latest comment");
  expect(f.ap.notes.get("ENG-1")?.level).toBe("info");
  expect(f.ap.startTriage("ENG-1").ok).toBe(false);
  await f.ap.poll(); // First-run baseline must retain the explicit proposal.
  expect(f.ap.lastPollError).toBeNull();
  expect(f.row().status).toBe("pending");
  const reopened = new Store(f.cfg.stateDir);
  try {
    const restarted = new Autopilot(f.cfg, reopened, f.tracker, f.llm);
    await restarted.poll();
    expect(reopened.getIssue(f.ticket.id)?.status).toBe("pending");
    expect(f.requests).toHaveLength(2);
  } finally { reopened.db.close(); }
});

for (const change of ["reassigned", "completed"] as const) {
  test(`manually triaged proposals are still dismissed when ${change}`, async () => {
    const f = await fixture();
    f.ap.startTriage("ENG-1");
    await finished();
    await f.ap.poll();
    await f.ap.poll(); // Clears automatic eligibility while retaining manual approval.
    if (change === "reassigned") f.ticket.assigneeId = "someone-else";
    else f.ticket.state = { name: "Done", type: "completed" };
    await f.ap.poll();
    expect(f.row().status).toBe("rejected");
    expect(existsSync(f.row().brief_path)).toBe(false);
  });
}

test("triaging existing work preserves every worktree, branch, launcher and PR snapshot", async () => {
  const f = await fixture();
  const path = join(f.dir, "existing worktree");
  mkdirSync(path);
  writeFileSync(join(path, "unsaved.txt"), "keep me");
  f.store.updateIssue(f.ticket.id, { repo: "api", repo_path: join(f.dir, "repos", "api"), branch: "original/ENG-1", launcher: "superset",
    worktree_id: worktreeId(path), extra_repos_json: JSON.stringify([{ repo: "web", repo_path: join(f.dir, "repos", "web"),
      reason: "Existing UI", worktree_id: worktreeId(join(f.dir, "web-work")), launcher: "git", branch: "other/ENG-1" }]) });
  f.store.setWork(f.ticket.id, JSON.stringify([work({ worktreePath: path, dirtyFiles: 1 })]), true);
  const before = f.row();
  expect(f.ap.startTriage("ENG-1")).toEqual({ ok: true });
  await finished();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].prompt).toContain("Target repo: api");
  const after = f.row();
  for (const key of ["status", "repo", "repo_path", "branch", "launcher", "worktree_id", "extra_repos_json", "work_json", "created_at"] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  expect(after.triage_source).toBe("manual");
  expect(readFileSync(join(path, "unsaved.txt"), "utf8")).toBe("keep me");
  expect(readFileSync(after.brief_path, "utf8")).toContain("Update the renderer");
});

test("failed triage keeps the original import and brief, and can be retried", async () => {
  const f = await fixture();
  const before = f.row();
  const brief = readFileSync(before.brief_path, "utf8");
  f.control.fail = true;
  f.ap.startTriage("ENG-1");
  await finished();
  expect(f.row()).toEqual(before);
  expect(readFileSync(before.brief_path, "utf8")).toBe(brief);
  expect(f.ap.notes.get("ENG-1")).toEqual({ level: "error", msg: "LLM unavailable" });
  f.control.fail = false;
  f.ap.startTriage("ENG-1");
  await finished();
  expect(f.row().status).toBe("pending");
  expect(f.ap.notes.get("ENG-1")?.level).toBe("info");
});

test("completed tickets receive an explanation without returning to approval; missing tickets remain retryable", async () => {
  const f = await fixture();
  expect(f.ap.startTriage("ENG-404").ok).toBe(false);
  f.control.missing = true;
  f.ap.startTriage("ENG-1");
  await finished();
  expect(needsTriage(f.row())).toBe(true);
  expect(f.ap.notes.get("ENG-1")?.level).toBe("error");
  f.control.missing = false;
  f.ticket.state = { name: "Done", type: "completed" };
  f.ap.startTriage("ENG-1");
  await finished();
  expect(f.row()).toMatchObject({ status: "running", triage_source: "manual" });
  expect(phaseOf(f.row(), null)).toBe("completed");
});

test("legacy databases distinguish imported summaries from generated explainers on migration", async () => {
  const f = await fixture();
  f.store.upsertIssue(rowFixture({ linear_id: "ticket-2", identifier: "ENG-2" }));
  f.store.db.exec("ALTER TABLE issues DROP COLUMN triage_source");
  const migrated = new Store(f.cfg.stateDir);
  try {
    expect(migrated.getIssue("ticket-1")?.triage_source).toBeNull();
    expect(migrated.getIssue("ticket-2")?.triage_source).toBe("automatic");
  } finally { migrated.db.close(); }
});

test("the triage form enforces request security and returns while model work is still running", async () => {
  const f = await fixture();
  const server = startWeb(f.ap, { configPath: join(f.dir, "config.json"), gh: () => ({ installed: false, accounts: [] }) });
  const base = `http://127.0.0.1:${server.port}`;
  const csrf = f.store.getMeta("csrf_token")!;
  const post = (token: string, origin = "http://localhost:0") => fetch(`${base}/issues/ENG-1/triage`, {
    method: "POST", body: new URLSearchParams({ csrf: token }), headers: { Host: "localhost:0", Origin: origin }, redirect: "manual",
  });
  let release!: () => void;
  f.control.gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    expect((await post(csrf, "https://evil.example")).status).toBe(403);
    expect(decodeURIComponent((await post("wrong")).headers.get("location")!)).toContain("out of date");
    expect(f.requests).toHaveLength(0);
    const res = await post(csrf);
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Triaging ENG-1");
    expect(launchSteps.has("ENG-1")).toBe(true);
    expect(decodeURIComponent((await post(csrf)).headers.get("location")!)).toContain("already working on it");
  } finally {
    release();
    await finished();
    server.stop(true);
  }
  expect(f.row().status).toBe("pending");
});

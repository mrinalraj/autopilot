import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { launcherFor, pathFromId, worktreeId, type SessionRequest } from "../../src/workspaces/launch";
import { Autopilot } from "../../src/app/autopilot";
import { Health } from "../../src/app/health";
import { Store } from "../../src/storage/db";
import type { Tracker } from "../../src/trackers/tracker";
import type { LLM } from "../../src/triage/llm";
import { issue } from "../fixtures/issues";
import { dashboardData } from "../../src/web/presenters/dashboard";
import { fakeSupersetHost } from "../fixtures/fake-superset-host";
import { launchSteps } from "../../src/app/steps";
import { handleAction } from "../../src/web/routes/actions";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (path: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-superset-")));
  roots.push(root);
  const bin = join(root, "superset");
  writeFileSync(bin, `#!${process.execPath}\n${readFileSync(join(import.meta.dir, "../fixtures/fake-superset.ts"), "utf8")}`, { mode: 0o755 });
  const repos = join(root, "repos with spaces");
  for (const name of ["api", "web"]) {
    const path = join(repos, name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "init");
    git(path, "update-ref", "refs/remotes/origin/main", "HEAD");
  }
  const cfg = loadConfig("/nonexistent");
  Object.assign(cfg, { repoRoots: [repos], stateDir: join(root, "state"), briefsDir: join(root, "briefs"), onboarded: true });
  Object.assign(cfg.launch, { launcher: "superset", supersetBin: bin, supacodeBin: "/nonexistent", fetch: false, base: "main", background: true });
  const calls = (): string[][] => existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const control = (value: object) => writeFileSync(join(root, "control.json"), JSON.stringify(value));
  const workspaceRows = () => readdirSync(join(root, "workspaces")).map((f) => JSON.parse(readFileSync(join(root, "workspaces", f), "utf8")));
  return { root, cfg, calls, control, workspaceRows, repo: join(repos, "api"), extra: join(repos, "web"), launcher: launcherFor(cfg) };
}

const request = (primaryPath: string, patch: Partial<SessionRequest> = {}): SessionRequest => ({
  identifier: "ENG-1", primaryPath, otherPaths: [], others: [], briefPath: "/briefs/a.md",
  prompt: "Read the user's brief; $(touch /never-run)", addDirs: ["/briefs with spaces", "/work/user's extra"], background: true, ...patch,
});

async function idle(identifier = "ENG-1") {
  const deadline = Date.now() + 5000;
  while (launchSteps.has(identifier)) {
    if (Date.now() > deadline) throw new Error("ticket action did not finish");
    await Bun.sleep(10);
  }
}

function legacyTicket(f: ReturnType<typeof fixture>, multi = false) {
  const primary = join(f.root, "old-supacode-worktree");
  git(f.repo, "worktree", "add", "-q", "-b", "fix-widget-eng-1", primary);
  writeFileSync(join(primary, "dirty.txt"), "keep this work");
  const extra = join(f.root, "old-extra-worktree");
  if (multi) git(f.extra, "worktree", "add", "-q", "-b", "different-branch-eng-1", extra);
  // Any accidental call to the old app fails loudly and leaves evidence.
  const oldCalls = join(f.root, "old-launcher-called");
  f.cfg.launch.supacodeBin = join(f.root, "old-supacode");
  writeFileSync(f.cfg.launch.supacodeBin, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(oldCalls)}, "unexpected call"); process.exit(1);`, { mode: 0o755 });
  const store = new Store(f.cfg.stateDir);
  const row = issue({ status: "running", repo_path: f.repo, brief_path: join(f.cfg.briefsDir, "ENG-1.md"), worktree_id: worktreeId(primary),
    extra_repos_json: multi ? JSON.stringify([{ repo: "web", repo_path: f.extra, reason: "Existing UI", branch: "different-branch-eng-1", launcher: "supacode", worktree_id: worktreeId(extra) }]) : "[]" });
  store.upsertIssue(row);
  store.updateIssue(row.linear_id, { launcher: "supacode" });
  const ap = new Autopilot(f.cfg, store, { kind: "linear", label: "Linear", issueState: async () => null } as unknown as Tracker, {} as LLM);
  const ctx = { ap, csrf: "token", bootId: "test", configPath: join(f.root, "config.json"), gh: () => ({ installed: false, accounts: [] }) };
  return { store, ap, row, primary, extra, oldCalls, ctx };
}

test("switching from Supacode to Superset adopts dirty multi-repo work in place without starting sessions or setup scripts", async () => {
  const f = fixture();
  const host = fakeSupersetHost(f.root);
  const legacy = legacyTicket(f, true);
  try {
    const before = legacy.store.getIssue(legacy.row.linear_id)!;
    expect(legacy.ap.reconfigureLaunchers()).toBe(1);
    await idle();
    expect(legacy.ap.notes.get("ENG-1")?.level).toBe("info");
    const after = legacy.store.getIssue(legacy.row.linear_id)!;
    expect(after).toMatchObject({ status: "running", launcher: "superset", worktree_id: before.worktree_id, branch: before.branch, created_at: before.created_at });
    expect(Store.extras(after)[0]).toMatchObject({ launcher: "superset", branch: "different-branch-eng-1", worktree_id: worktreeId(legacy.extra) });
    expect(host.calls.map((c) => c.worktreePath)).toEqual([legacy.primary, legacy.extra]);
    expect(f.calls().some((c) => ["terminals", "workspaces"].includes(c[0]) && c[1] === "create")).toBe(false);
    expect(readFileSync(join(legacy.primary, "dirty.txt"), "utf8")).toBe("keep this work");
    expect(existsSync(legacy.oldCalls)).toBe(false);
    const data = await dashboardData(legacy.ctx);
    expect([...data.worktreeLinks.get(legacy.row.linear_id)!.values()].every((link) => link?.startsWith("superset://"))).toBe(true);
    const calls = f.calls();
    expect(legacy.ap.reconfigureLaunchers()).toBe(0);
    const restarted = new Autopilot(f.cfg, legacy.store, {} as Tracker, {} as LLM);
    expect(restarted.reconfigureLaunchers()).toBe(0);
    expect(f.calls()).toEqual(calls); // completed setup survives restarts without commands or sessions
    expect(host.calls).toHaveLength(2);
    expect(existsSync(legacy.oldCalls)).toBe(false);
  } finally { host.close(); legacy.store.db.close(); }
});

test("automatic setup retries failures without a tracker and stops issuing commands after success", async () => {
  const f = fixture();
  const host = fakeSupersetHost(f.root);
  const legacy = legacyTicket(f);
  try {
    host.control.fail = true;
    legacy.ap.reconfigureLaunchers();
    await idle();
    expect(legacy.store.getIssue(legacy.row.linear_id)?.launcher).toBe("supacode");
    expect(legacy.ap.notes.get("ENG-1")?.msg).toContain("adoption failed");
    expect(legacy.ap.notes.get("ENG-1")?.msg).toContain("will retry automatically");
    expect((await dashboardData(legacy.ctx)).worktreeLinks.get(legacy.row.linear_id)?.get(legacy.primary)).toBeNull();
    expect(existsSync(legacy.oldCalls)).toBe(false);
    host.control.fail = false;
    expect(legacy.ap.reconfigureLaunchers()).toBe(1); // next daemon setup tick; no user action or tracker call
    expect(legacy.ap.reconfigureLaunchers()).toBe(0); // don't overlap an in-flight attempt
    await idle();
    expect(legacy.store.getIssue(legacy.row.linear_id)?.launcher).toBe("superset");
    expect(readFileSync(join(legacy.primary, "dirty.txt"), "utf8")).toBe("keep this work");
    expect(existsSync(legacy.oldCalls)).toBe(false);
    const calls = f.calls();
    expect(legacy.ap.reconfigureLaunchers()).toBe(0);
    expect(f.calls()).toEqual(calls);
    expect(host.calls).toHaveLength(2); // one failed request, then one successful adoption
    expect(f.calls().filter((c) => c[0] === "terminals" && c[1] === "create")).toHaveLength(0);
  } finally { host.close(); legacy.store.db.close(); }
});

test("editor links and cleanup follow the selection immediately, including legacy and unknown stored launchers", async () => {
  const f = fixture();
  const legacy = legacyTicket(f);
  try {
    for (const old of ["supacode", null, "unknown-old-tool"]) {
      legacy.store.updateIssue(legacy.row.linear_id, { launcher: old });
      f.cfg.launch.launcher = "cursor";
      const data = await dashboardData(legacy.ctx);
      expect(data.worktreeLinks.get(legacy.row.linear_id)?.get(legacy.primary)).toBe(`cursor://file${encodeURI(legacy.primary)}`);
      expect(data.canResendPrompt).toBe(true);
    }
    for (const selected of ["cursor", "vscode", "worktrunk", "git"] as const) {
      f.cfg.launch.launcher = selected;
      legacy.ap.reconfigureLaunchers();
      await idle();
      expect(legacy.store.getIssue(legacy.row.linear_id)?.launcher).toBe(selected);
      expect(readFileSync(join(legacy.primary, "dirty.txt"), "utf8")).toBe("keep this work");
    }
    f.cfg.launch.launcher = "git";
    expect((await legacy.ap.deleteWorktrees("ENG-1", false)).ok).toBe(false); // dirty work still protected
    expect((await legacy.ap.deleteWorktrees("ENG-1", true)).ok).toBe(true);
    expect(existsSync(legacy.primary)).toBe(false);
    expect(git(f.repo, "rev-parse", "--verify", "refs/heads/fix-widget-eng-1")).not.toBe("");
    expect(existsSync(legacy.oldCalls)).toBe(false);
    expect(f.calls()).toEqual([]); // no Superset calls either
  } finally { legacy.store.db.close(); }
});

test("retrying an old Supacode launch uses Superset and adopts the existing branch instead of recreating it", async () => {
  const f = fixture();
  const host = fakeSupersetHost(f.root);
  const legacy = legacyTicket(f);
  try {
    legacy.store.updateIssue(legacy.row.linear_id, { status: "failed" });
    expect(legacy.ap.approve("ENG-1", "api", legacy.row.branch)).toEqual({ ok: true });
    await idle();
    await legacy.ap.refreshWork(legacy.row.linear_id);
    expect(legacy.store.getIssue(legacy.row.linear_id)).toMatchObject({ status: "running", launcher: "superset", worktree_id: worktreeId(legacy.primary) });
    expect(host.calls).toHaveLength(1);
    expect(f.calls().filter((c) => c[0] === "workspaces" && c[1] === "create")).toHaveLength(0);
    expect(f.calls().filter((c) => c[0] === "terminals" && c[1] === "create")).toHaveLength(1);
    expect(readFileSync(join(legacy.primary, "dirty.txt"), "utf8")).toBe("keep this work");
    expect(existsSync(legacy.oldCalls)).toBe(false);
  } finally { host.close(); legacy.store.db.close(); }
});

test("invalid launcher names cannot fall back to Supacode or inherited registry properties", () => {
  const f = fixture();
  for (const name of ["unknown", "toString", "constructor"]) {
    f.cfg.launch.launcher = name as never;
    expect(() => launcherFor(f.cfg)).toThrow("Unknown launcher");
  }
  expect(f.calls()).toEqual([]);
});

test("saving a launcher change starts migration and refuses another change while it is running", async () => {
  const f = fixture();
  const host = fakeSupersetHost(f.root);
  const legacy = legacyTicket(f);
  f.cfg.launch.launcher = "supacode";
  writeFileSync(legacy.ctx.configPath, JSON.stringify(f.cfg));
  const form = new FormData();
  for (const [key, value] of Object.entries({ launcher: "superset", repoRoots: f.cfg.repoRoots.join("\n"), repoPaths: "", pollMinutes: "5", workMinutes: "2",
    lowConfidenceThreshold: "0.6", provider: "cli", model: "test-model", terminal: "none", base: "main" })) form.set(key, value);
  let release!: () => void;
  host.control.gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const response = await handleAction("/settings", form, legacy.ctx);
    expect(decodeURIComponent(response.headers.get("location")!)).toContain("Existing worktrees are being configured");
    expect(String(f.cfg.launch.launcher)).toBe("superset");
    expect(legacy.ap.launcherBusy).toBe(true);
    form.set("launcher", "git");
    const blocked = await handleAction("/settings", form, legacy.ctx);
    expect(decodeURIComponent(blocked.headers.get("location")!)).toContain("still running");
    expect(String(f.cfg.launch.launcher)).toBe("superset");
  } finally {
    release();
    await idle();
    host.close();
    legacy.store.db.close();
  }
  expect(existsSync(legacy.oldCalls)).toBe(false);
});

test("Superset adoption rejects main checkouts, wrong branches and nonlocal host manifests", async () => {
  const f = fixture();
  const host = fakeSupersetHost(f.root);
  const legacy = legacyTicket(f);
  try {
    await expect(f.launcher.adoptWorktree(f.repo, f.repo, "main")).rejects.toThrow("not an isolated worktree");
    await expect(f.launcher.adoptWorktree(f.repo, legacy.primary, "wrong-branch")).rejects.toThrow("not an isolated worktree");
    writeFileSync(host.manifest, JSON.stringify({ endpoint: "https://example.test", authToken: "fixture-token" }));
    await expect(f.launcher.adoptWorktree(f.repo, legacy.primary, legacy.row.branch)).rejects.toThrow("authenticated local endpoint");
    expect(host.calls).toHaveLength(0);
    expect(existsSync(legacy.oldCalls)).toBe(false);
  } finally { host.close(); legacy.store.db.close(); }
});

test("Superset registers the repo, creates the exact branch, and reuses it on retry", async () => {
  const f = fixture();
  const path = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  expect(git(path, "branch", "--show-current")).toBe("fix-widget-eng-1");
  expect(await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", false)).toBe(path);
  expect(f.calls().filter((c) => c[0] === "projects" && c[1] === "create")).toHaveLength(1);
  const creates = f.calls().filter((c) => c[0] === "workspaces" && c[1] === "create");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toContain("--skip-branch-prefix");
  expect(creates[0].slice(creates[0].indexOf("--base-branch"), creates[0].indexOf("--base-branch") + 2)).toEqual(["--base-branch", "main"]);
  expect(f.calls().every((c) => c.includes("--local"))).toBe(true);
});

test("Claude receives the brief and all add-dir paths, with foreground/background behavior", async () => {
  const f = fixture();
  const path = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  const req = request(path);
  await f.launcher.openSession(req);
  expect(f.calls().some((c) => c[1] === "open")).toBe(false);
  const terminal = f.calls().find((c) => c[0] === "terminals")!;
  expect(terminal[terminal.indexOf("--cwd") + 1]).toBe(path);
  const command = terminal[terminal.indexOf("--command") + 1];
  // Parse with a real shell into argv without executing the command or any prompt text.
  const argvFile = join(f.root, "argv.json");
  const capture = join(f.root, "claude");
  writeFileSync(capture, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
  const shell = Bun.spawnSync(["/bin/sh", "-c", command], { env: { ...process.env, PATH: `${f.root}:/usr/bin:/bin` }, stderr: "pipe" });
  expect(shell.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([req.prompt, "--add-dir", ...req.addDirs]);
  await f.launcher.openSession({ ...req, background: false });
  expect(f.calls().filter((c) => c[1] === "open")).toHaveLength(1);
});

test("simultaneous first approvals register one project for the same repo", async () => {
  const f = fixture();
  const paths = await Promise.all([
    f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true),
    launcherFor(f.cfg).ensureWorktree(f.repo, "fix-widget-eng-2", true),
  ]);
  expect(paths[0]).not.toBe(paths[1]);
  expect(f.calls().filter((c) => c[0] === "projects" && c[1] === "create")).toHaveLength(1);
  expect(f.workspaceRows()).toHaveLength(2);
});

test("workspace links survive a fresh config and share one inventory; offline links degrade gracefully", async () => {
  const f = fixture();
  const path = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  const fresh = launcherFor(structuredClone(f.cfg));
  const before = f.calls().length;
  const link = `superset://v2-workspace/${f.workspaceRows()[0].id}`;
  expect(await Promise.all([fresh.link(path), fresh.link(path)])).toEqual([link, link]);
  expect(f.calls().length - before).toBe(1);
  f.control({ fail: "workspaces list" });
  expect(await launcherFor(structuredClone(f.cfg)).link(path)).toBeNull();
  await expect(f.launcher.adoptWorktree(f.repo, path, "fix-widget-eng-1")).rejects.toThrow("fake Superset failure");
});

test("archive uses Superset, keeps the branch, and refuses main checkouts or mismatched branches", async () => {
  const f = fixture();
  const path = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  const row = f.workspaceRows()[0];
  writeFileSync(join(f.root, "workspaces", "main.json"), JSON.stringify({ ...row, id: "main", type: "local", worktreePath: f.repo }));
  expect(await f.launcher.link(f.repo)).toBeNull();
  await expect(f.launcher.removeWorktree(f.repo, f.repo, "main", true)).rejects.toThrow("Expected one Superset worktree");
  await expect(f.launcher.removeWorktree(f.repo, path, "other-branch", true)).rejects.toThrow("Refusing to archive");
  await f.launcher.removeWorktree(f.repo, path, "fix-widget-eng-1", false);
  expect(existsSync(path)).toBe(false);
  expect(git(f.repo, "rev-parse", "--verify", "refs/heads/fix-widget-eng-1")).not.toBe("");
  expect(f.calls().filter((c) => c[1] === "archive")).toEqual([["workspaces", "archive", row.id, "--json", "--local"]]);
});

test("archive failure or incomplete deletion is reported instead of falling back to git", async () => {
  const f = fixture();
  const path = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  f.control({ fail: "workspaces archive" });
  await expect(f.launcher.removeWorktree(f.repo, path, "fix-widget-eng-1", true)).rejects.toThrow("fake Superset failure");
  expect(existsSync(path)).toBe(true);
  f.control({ keepWorktree: true });
  await expect(f.launcher.removeWorktree(f.repo, path, "fix-widget-eng-1", true)).rejects.toThrow("still exists");
});

for (const pending of [false, true]) test(`imports ${pending ? "pending" : "untracked"} tickets without consulting unselected tools and preserves each branch`, async () => {
  const f = fixture();
  const primary = await f.launcher.ensureWorktree(f.repo, "fix-widget-eng-1", true);
  const extra = join(f.root, "external-web");
  git(f.extra, "worktree", "add", "-q", "-b", "web-widget-eng-1", extra);
  const row = issue({ repo_path: f.repo, brief_path: join(f.cfg.briefsDir, "ENG-1.md") });
  const tracker = {
    kind: "linear", label: "Linear", me: async () => ({ teams: [{ key: "ENG" }] }),
    issueState: async () => null, mineInStates: async () => [],
    issue: async () => ({ id: row.linear_id, identifier: row.identifier, title: row.title, url: row.url,
      description: "Imported work", state: { name: "In Progress", type: "started" },
      team: { key: "ENG", name: "Engineering" }, project: null, labels: [], comments: [], attachments: [] }),
  } as unknown as Tracker;
  const store = new Store(f.cfg.stateDir);
  if (pending) store.upsertIssue(row);
  const ap = new Autopilot(f.cfg, store, tracker, { json: async () => { throw new Error("Imports must not triage"); } });
  try {
    expect(await ap.importExisting()).toEqual([row.identifier]);
    const imported = store.getIssue(row.linear_id)!;
    expect(imported).toMatchObject({ status: "running", launcher: null, branch: "fix-widget-eng-1" });
    expect(Store.extras(imported)[0]).toMatchObject({ branch: "web-widget-eng-1" });
    const data = await dashboardData({ ap, csrf: "token", bootId: "test", configPath: "unused", gh: () => ({ installed: false, accounts: [] }) });
    expect(data.worktreeLinks.get(row.linear_id)?.get(primary)).toStartWith("superset://");
    expect(data.worktreeLinks.get(row.linear_id)?.get(extra)).toBeNull();
    f.cfg.launch.launcher = "git";
    expect((await ap.deleteWorktrees(row.identifier, false)).ok).toBe(true);
    expect(existsSync(primary)).toBe(false);
    expect(existsSync(extra)).toBe(false);
    expect(f.calls().filter((c) => c[1] === "archive")).toHaveLength(0);
  } finally { store.db.close(); }
});

test("multi-repo approval, failed session retry, selected launcher cleanup, and send-back", async () => {
  const f = fixture();
  const store = new Store(f.cfg.stateDir);
  const tracker = { kind: "linear", label: "Linear", issueState: async () => null } as unknown as Tracker;
  const ap = new Autopilot(f.cfg, store, tracker, {} as LLM);
  const row = issue({ repo_path: f.repo, brief_path: join(f.cfg.briefsDir, "ENG-1.md"), launcher: null,
    extra_repos_json: JSON.stringify([{ repo: "web", repo_path: f.extra, reason: "UI", worktree_id: null }]) });
  store.upsertIssue(row);
  const settle = async () => {
    for (let n = 0; n < 200 && store.getIssue(row.linear_id)!.status === "approved"; n++) await Bun.sleep(25);
    expect(store.getIssue(row.linear_id)!.status).not.toBe("approved");
    await ap.refreshWork(row.linear_id);
  };
  try {
    f.control({ fail: "terminals create" });
    expect(ap.approve(row.identifier, "api", row.branch, ["web"])).toEqual({ ok: true });
    await settle();
    expect(store.getIssue(row.linear_id)!.status).toBe("failed");
    expect(f.workspaceRows()).toHaveLength(2);
    f.control({});
    expect(ap.approve(row.identifier, "api", row.branch, ["web"])).toEqual({ ok: true });
    await settle();
    const running = store.getIssue(row.linear_id)!;
    expect(running.status).toBe("running");
    expect(running.launcher).toBe("superset");
    expect(f.calls().filter((c) => c[0] === "workspaces" && c[1] === "create")).toHaveLength(2);
    const extra = pathFromId(Store.extras(running)[0].worktree_id!);
    const terminal = f.calls().filter((c) => c[0] === "terminals").at(-1)!;
    expect(terminal[terminal.indexOf("--command") + 1]).toContain(extra);
    expect(readFileSync(running.brief_path, "utf8")).toContain(extra);
    const data = await dashboardData({ ap, csrf: "token", bootId: "test", configPath: "unused", gh: () => ({ installed: false, accounts: [] }) });
    expect([...data.worktreeLinks.get(row.linear_id)!.values()].every((link) => link?.startsWith("superset://v2-workspace/"))).toBe(true);
    writeFileSync(join(pathFromId(running.worktree_id!), "uncommitted.txt"), "keep me");
    f.cfg.launch.launcher = "git";
    expect((await ap.deleteWorktrees(row.identifier, false)).ok).toBe(false);
    expect(f.calls().some((c) => c[1] === "archive")).toBe(false);
    expect((await ap.sendBackToApproval(row.identifier, true)).ok).toBe(true);
    expect(f.calls().filter((c) => c[1] === "archive")).toHaveLength(0);
    expect(store.getIssue(row.linear_id)).toMatchObject({ status: "pending", launcher: null, worktree_id: null, work_json: null });
  } finally { store.db.close(); }
});

test("setup checks distinguish a missing CLI from an offline host without Supacode/terminal hints", async () => {
  const f = fixture();
  f.cfg.llm.provider = "api";
  f.cfg.launch.terminal = "warp";
  const healthy = await new Health(f.cfg).refresh();
  expect(healthy.some((i) => ["launcher-superset", "superset-host", "supacode-hint", "terminal-warp"].includes(i.id))).toBe(false);
  f.control({ offline: true });
  expect((await new Health(f.cfg).refresh()).find((i) => i.id === "superset-host")?.level).toBe("required");
  f.cfg.launch.supersetBin = "/nonexistent/superset";
  expect((await new Health(f.cfg).refresh()).find((i) => i.id === "launcher-superset")?.level).toBe("required");
});

test("setup accepts a reachable desktop host even when status reports a stale process", async () => {
  const f = fixture();
  f.cfg.llm.provider = "api";
  f.control({ staleStatus: true });
  const status = Bun.spawnSync([f.cfg.launch.supersetBin, "status", "--json"], { env: process.env });
  expect(JSON.parse(status.stdout.toString())).toMatchObject({ running: false, stale: true });
  expect((await new Health(f.cfg).refresh()).some((i) => i.id === "superset-host")).toBe(false);
  expect(f.calls().at(-1)).toEqual(["projects", "list", "--local", "--json"]);
});

test("setup reports failed or invalid local queries without assuming the host is stopped, then recovers", async () => {
  const f = fixture();
  f.cfg.llm.provider = "api";
  const health = new Health(f.cfg);
  for (const control of [{ fail: "projects list", error: "Session expired" }, { malformed: true }]) {
    f.control(control);
    const item = (await health.refresh()).find((i) => i.id === "superset-host")!;
    expect(item.title).toBe("Autopilot can't connect to Superset");
    expect(item.detail).toContain("desktop app starts its local host automatically");
    expect(item.detail).toContain("superset start --daemon");
    expect(item.command).toContain("projects list --local --json");
  }
  f.control({});
  expect((await health.refresh()).some((i) => i.id === "superset-host")).toBe(false);
});

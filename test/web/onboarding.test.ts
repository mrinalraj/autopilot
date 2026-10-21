import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { Store } from "../../src/storage/db";
import { Autopilot } from "../../src/app/autopilot";
import { startWeb } from "../../src/web/server";
import { suggestFolders } from "../../src/repos/suggestions";
import type { GithubStatus } from "../../src/platform/github";
import type { LLM } from "../../src/triage/llm";
import { LoginRequiredError, type Tracker } from "../../src/trackers/tracker";

const dir = mkdtempSync(join(tmpdir(), "autopilot-setup-"));
const port = 47900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const configPath = join(dir, "config.json");
const reposRoot = join(dir, "code");
let gh: GithubStatus = { installed: true, accounts: [] };
let signedIn = false;
let polls = 0;
let server: ReturnType<typeof startWeb>;
let ap: Autopilot;

beforeAll(() => {
  process.env.AUTOPILOT_NOTIFY = "off";
  for (const name of ["api", "web"]) mkdirSync(join(reposRoot, name, ".git"), { recursive: true });
  const cfg = { ...loadConfig(configPath), port, stateDir: join(dir, "state"), briefsDir: join(dir, "state", "briefs") };
  // Settings reload config.json: keep every write inside this test's home as well.
  writeFileSync(configPath, JSON.stringify(cfg));
  const me = { id: "me", name: "Mo", email: "mo@example.com", teams: [{ id: "t", key: "ENG", name: "Eng" }] };
  const tracker = {
    kind: "linear", label: "Linear",
    me: async () => {
      if (!signedIn) throw new LoginRequiredError("Linear");
      return me;
    },
    viewer: async () => me,
    teamStatuses: async () => [{ team: "Eng", name: "Todo", type: "unstarted" }, { team: "Eng", name: "In Progress", type: "started" }],
    assignedToMe: async () => {
      polls++;
      return [];
    },
    mineInStates: async () => [],
    issue: async () => null,
  } as unknown as Tracker;
  ap = new Autopilot(cfg, new Store(cfg.stateDir), tracker, {} as LLM);
  server = startWeb(ap, { configPath, gh: () => gh, health: { items: [], refresh: async () => [] } as never });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const csrf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await (await fetch(`${base}/setup`)).text())![1];
const post = async (path: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams({ csrf: await csrf() });
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return fetch(`${base}${path}`, { method: "POST", body, headers: { Origin: base }, redirect: "manual" });
};
const html = async (path: string) => (await fetch(`${base}${path}`)).text();
const raw = () => JSON.parse(readFileSync(configPath, "utf8"));

test("a fresh install goes to setup, starting at repos, and nothing is polled", async () => {
  expect(ap.cfg.onboarded).toBe(false);
  const res = await fetch(`${base}/`, { redirect: "manual" });
  expect([res.status, res.headers.get("location")]).toEqual([303, "/setup"]);
  const page = await html("/setup");
  expect(page).toContain("Where's your code?");
  expect(page).toContain('<li class="current"><a href="/setup?step=repos">1. Repos</a></li>');
  await ap.pollIfReady();
  expect(polls).toBe(0);
});

test("step 1: parent folders and individual repos are validated and saved", async () => {
  const empty = await post("/setup/repos", {});
  expect(decodeURIComponent(empty.headers.get("location")!)).toContain("Add at least one folder or repo.");
  const ok = await post("/setup/repos", { root: reposRoot, repoPaths: "" });
  expect(ok.headers.get("location")).toBe("/setup?step=github");
  expect(raw().repoRoots).toEqual([reposRoot]);
  expect(await html("/setup?step=repos")).toContain("Using 2 repos: api, web");
});

test("step 2: gh is required; sign-in or install is offered, and the account is pinned", async () => {
  gh = { installed: false, accounts: [] };
  expect(await html("/setup?step=github")).toContain("Install and sign in (opens Terminal)");
  gh = { installed: true, accounts: [] };
  const signIn = await html("/setup?step=github");
  expect(signIn).toContain("Sign in to GitHub (opens Terminal)");
  expect(signIn).not.toContain('action="/setup/github"'); // no way past without an account

  gh = { installed: true, accounts: [{ name: "work", active: false }, { name: "personal", active: true }] };
  expect(await html("/setup?step=github")).toContain('value="personal" checked');
  const bad = await post("/setup/github", { githubUser: "stranger" });
  expect(decodeURIComponent(bad.headers.get("location")!)).toContain("Pick one of your gh accounts.");
  expect((await post("/setup/github", { githubUser: "work" })).headers.get("location")).toBe("/setup?step=tracker");
  expect(raw().githubUser).toBe("work");
});

test("step 3: connect a tracker; Continue appears once signed in", async () => {
  const out = await html("/setup?step=tracker");
  expect(out).toContain("Connect Linear");
  expect(out).toContain('name="from" value="setup"');
  expect(out).not.toContain('href="/setup?step=statuses">Continue');
  signedIn = true;
  const inn = await html("/setup?step=tracker");
  expect(inn).toContain("Signed in to Linear as <strong>Mo</strong>");
  expect(inn).toContain('<a class="btn primary" href="/setup?step=statuses">Continue</a>');
});

test("step 4: statuses come from the tracker and are saved", async () => {
  const out = await html("/setup?step=statuses");
  expect(out).toContain('value="Todo"');
  expect(out).toContain('value="In Progress"');
  const res = await post("/setup/statuses", { pickupStates: "Todo", importStates: "In Progress", importWorktrees: "on" });
  expect(res.headers.get("location")).toBe("/setup?step=start");
  expect([raw().pickupStates, raw().importStates, raw().importWorktrees]).toEqual([["Todo"], ["In Progress"], true]);
});

test("step 5 explains the flow; Start finishes setup and polling begins", async () => {
  const out = await html("/setup?step=start");
  expect(out).toContain("How it works");
  expect(out).toContain("tickets assigned to you in “Todo”");
  expect(out).toContain("as work on GitHub");
  const res = await post("/setup/finish", {});
  expect(res.headers.get("location")!.startsWith("/?notice=")).toBe(true);
  expect(raw().onboarded).toBe(true);
  await Bun.sleep(50);
  expect(polls).toBeGreaterThan(0);
  expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(200);
});

test("folder suggestions list home folders that hold git repos, most first", () => {
  const home = join(dir, "home");
  for (const p of ["code/a", "code/b", "work/c", "Library/x", "notes/plain"]) mkdirSync(join(home, p, p.endsWith("plain") ? "" : ".git"), { recursive: true });
  writeFileSync(join(home, "file.txt"), "");
  expect(suggestFolders(home)).toEqual([
    { path: join(home, "code"), repos: ["a", "b"] },
    { path: join(home, "work"), repos: ["c"] },
  ]);
});

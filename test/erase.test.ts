import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { Autopilot } from "../src/autopilot";
import { resetSettingsFile } from "../src/settings";
import type { LLM } from "../src/llm";
import type { Tracker } from "../src/tracker";

const dir = mkdtempSync(join(tmpdir(), "autopilot-erase-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const row = (id: string, status: "pending" | "running") => ({
  linear_id: id, identifier: id, title: "t", url: "u", brief_path: join(dir, "state", "briefs", `${id}.md`), repo: "api", repo_path: "/x",
  branch: `b-${id.toLowerCase()}`, confidence: 1, resolve_reason: "", status, error: null, worktree_id: null,
  ticket_json: "{}", explainer_json: "{}", extra_repos_json: "[]",
});

test("erase all removes every ticket, brief and cache but keeps settings; the next first run queues what's eligible", async () => {
  process.env.AUTOPILOT_NOTIFY = "off";
  const cfg = { ...loadConfig("/nonexistent"), stateDir: join(dir, "state"), briefsDir: join(dir, "state", "briefs"), processExistingOnFirstRun: false };
  mkdirSync(cfg.briefsDir, { recursive: true });
  const store = new Store(cfg.stateDir);
  store.upsertIssue(row("ENG-1", "pending"));
  store.upsertIssue(row("ENG-2", "running")); // launched/imported: also erased
  store.markAssigned("ENG-1", "ENG-1", true);
  store.setMeta("poll_cursor", new Date().toISOString());
  store.dismissBanner("gh-login");
  writeFileSync(join(cfg.briefsDir, "ENG-1.md"), "brief");
  writeFileSync(join(cfg.briefsDir, "keep.txt"), "not ours");
  writeFileSync(join(cfg.stateDir, "catalog.cache.json"), "{}");

  const tracker = {
    kind: "linear", label: "Linear",
    viewer: async () => ({ id: "me", name: "Me", email: null }),
    me: async () => ({ id: "me", name: "Me", email: null, teams: [] }),
    assignedToMe: async () => [{ id: "ENG-3", identifier: "ENG-3", assigneeId: "me", stateName: "Ready for Development", stateType: "unstarted" }],
    issue: async () => { throw new Error("offline"); }, // leaves the queued ticket queued for this check
    mineInStates: async () => [],
  } as unknown as Tracker;
  const ap = new Autopilot(cfg, store, tracker, {} as LLM);
  expect(await ap.eraseAll()).toEqual({ ok: true });

  expect(ap.isEmpty()).toBe(true);
  expect(ap.store.getMeta("poll_cursor")).toBeNull();
  expect(ap.store.dismissedBanners().size).toBe(0);
  expect(readdirSync(cfg.briefsDir)).toEqual([]); // the custom file went with the briefs dir under state/
  expect(existsSync(join(cfg.stateDir, "catalog.cache.json"))).toBe(false);

  await ap.poll(); // first run again, but queued rather than baselined (processExistingOnFirstRun is off)
  expect(ap.store.unhandled().map((a) => a.identifier)).toEqual(["ENG-3"]);
});

test("resetting settings keeps only what sign-in and the address depend on, and runs setup again", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ tracker: "jira", jira: { site: "acme", pickupStates: ["To Do"] }, port: 4999, reposRoot: "~/x", githubUser: "me" }));
  resetSettingsFile(path);
  expect(JSON.parse(require("node:fs").readFileSync(path, "utf8"))).toEqual({ onboarded: false, tracker: "jira", port: 4999, jira: { site: "acme" } });
});

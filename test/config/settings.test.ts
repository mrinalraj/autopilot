import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { saveSettings, saveTracker } from "../../src/config/settings";

const dir = mkdtempSync(join(tmpdir(), "autopilot-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const configPath = join(dir, "config.json");
const reposRoot = join(dir, "code");
for (const name of ["api", "web"]) mkdirSync(join(reposRoot, name, ".git"), { recursive: true });
writeFileSync(join(reposRoot, "web", "README.md"), "# Web\n\nThe frontend.\n");
writeFileSync(configPath, JSON.stringify({ stateDir: join(dir, "state"), customKey: "kept", llm: { claudeBin: "/x/claude" } }));

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const valid = {
  pickupStates: ["Ready for Development"], pickupStatesOther: "Todo, ",
  importStates: "In Development", importWorktrees: "on",
  pollMinutes: "15", workMinutes: "2", repoRoots: reposRoot, launcher: "worktrunk", terminal: "iterm", worktreesDir: "",
  fetch: "on", base: "", provider: "cli", model: "claude-opus-5-5", lowConfidenceThreshold: "0.5", githubUser: "someone",
  "present:api": "1", "include:api": "on", "desc:api": "Backend service",
  "present:web": "1", "desc:web": "Web: The frontend.", // unticked include → excluded; description equals the derived one
};

test("saving writes config.json, keeps unknown keys and applies to the running config", () => {
  const cfg = loadConfig(configPath);
  const res = saveSettings(cfg, form(valid), configPath);
  expect(res.errors).toEqual([]);

  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  expect(raw.customKey).toBe("kept");
  expect(raw.llm).toEqual({ claudeBin: "/x/claude", provider: "cli", model: "claude-opus-5-5" });
  expect(raw.pickupStates).toEqual(["Ready for Development", "Todo"]);
  expect(raw.pollIntervalSeconds).toBe(900);
  expect(raw.launch).toMatchObject({ launcher: "worktrunk", terminal: "iterm", fetch: true, background: false });
  expect(raw.repos).toEqual({ api: { description: "Backend service" }, web: { exclude: true } });

  expect(cfg.pollIntervalSeconds).toBe(900); // applied in place
  expect(cfg.launch.launcher).toBe("worktrunk");
  expect(cfg.githubUser).toBe("someone");
});

test("invalid input is rejected and nothing is written", () => {
  const before = readFileSync(configPath, "utf8");
  const res = saveSettings(loadConfig(configPath), form({ ...valid, pollMinutes: "0", repoRoots: "/nope", launcher: "emacs" }), configPath);
  expect(res.errors.join(" ")).toContain("Poll interval");
  expect(res.errors.join(" ")).toContain("doesn't exist");
  expect(res.errors.join(" ")).toContain("launcher");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("Superset can be selected in Settings while retaining a custom CLI path", () => {
  const path = join(dir, "superset.json");
  writeFileSync(path, JSON.stringify({ launch: { supersetBin: "/custom/bin/superset" } }));
  const cfg = loadConfig(path);
  expect(saveSettings(cfg, form({ ...valid, launcher: "superset" }), path).errors).toEqual([]);
  expect(cfg.launch).toMatchObject({ launcher: "superset", supersetBin: "/custom/bin/superset" });
  expect(loadConfig(path).launch.launcher).toBe("superset");
});

test("individual repos and ticket prefixes are validated and saved", () => {
  const elsewhere = join(dir, "elsewhere", "api");
  mkdirSync(join(elsewhere, ".git"), { recursive: true });
  const cfg = loadConfig(configPath);
  const bad = saveSettings(cfg, form({ ...valid, repoRoots: "", repoPaths: `${elsewhere}\n${join(dir, "nope")}`, ticketPrefixes: "eng, 9x" }), configPath);
  expect(bad.errors.join(" ")).toContain("isn't a git repo");
  expect(bad.errors.join(" ")).toContain('Ticket prefix "9X"');

  const ok = saveSettings(cfg, form({ ...valid, repoRoots: "", repoPaths: `${elsewhere}\n${join(reposRoot, "api")}`, ticketPrefixes: "eng it" }), configPath);
  expect(ok.errors).toEqual([]);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  expect([raw.repoRoots, raw.repoMode, raw.reposRoot]).toEqual([[], undefined, undefined]);
  expect(raw.ticketPrefixes).toEqual(["ENG", "IT"]);
  expect(cfg.repoPaths).toEqual([elsewhere, join(reposRoot, "api")]);
});

test("same-named repos get distinct names", async () => {
  const { repoSources } = await import("../../src/repos/catalog");
  const cfg = loadConfig(configPath);
  expect(repoSources(cfg).map((r) => r.name)).toEqual(["api", "code-api"]);
});

test("each tracker keeps its own pickup and import statuses", () => {
  const path = join(dir, "tracker.json");
  writeFileSync(path, JSON.stringify({ stateDir: join(dir, "state"), pickupStates: ["Ready for Development"] }));
  expect(saveTracker(form({ tracker: "jira", jiraSite: "https://acme.atlassian.net" }), path)).toEqual({ ok: true, tracker: "jira" });
  const jira = loadConfig(path);
  expect([jira.tracker, jira.jira.site, jira.pickupStates]).toEqual(["jira", "https://acme.atlassian.net", ["Ready for Development"]]);

  expect(saveSettings(jira, form({ ...valid, pickupStates: "To Do", pickupStatesOther: "" }), path).errors).toEqual([]);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  expect(raw.jira.pickupStates).toEqual(["To Do"]);
  expect(raw.pickupStates).toEqual(["Ready for Development"]); // Linear's untouched
  expect(jira.pickupStates).toEqual(["To Do"]); // applied live

  saveTracker(form({ tracker: "linear" }), path);
  expect(loadConfig(path).pickupStates).toEqual(["Ready for Development"]);
  expect(loadConfig(path).jira.site).toBe("https://acme.atlassian.net"); // no jiraSite field: kept
  expect(saveTracker(form({ tracker: "trello" }), path)).toEqual({ ok: false, error: "Pick Linear or Jira." });
});

test("parent folders and individual repos combine; older configs migrate; fresh installs need setup", async () => {
  const { repoSources } = await import("../../src/repos/catalog");
  const solo = join(dir, "solo", "tool");
  mkdirSync(join(solo, ".git"), { recursive: true });
  const both = repoSources({ ...loadConfig(configPath), repoRoots: [reposRoot], repoPaths: [solo, join(reposRoot, "api")] });
  expect(both.map((r) => r.name)).toEqual(["api", "web", "tool"]); // api once, though listed twice

  const legacy = join(dir, "legacy.json");
  writeFileSync(legacy, JSON.stringify({ reposRoot, repoPaths: ["/ignored/in/folder/mode"] }));
  expect([loadConfig(legacy).repoRoots, loadConfig(legacy).repoPaths, loadConfig(legacy).onboarded]).toEqual([[reposRoot], [], true]);
  writeFileSync(legacy, JSON.stringify({ repoMode: "list", reposRoot: "/x", repoPaths: [solo] }));
  expect([loadConfig(legacy).repoRoots, loadConfig(legacy).repoPaths]).toEqual([[], [solo]]);
  expect([loadConfig("/nonexistent").repoRoots, loadConfig("/nonexistent").onboarded]).toEqual([[], false]);
});

test("folders picked in Finder: repos join the individual list, other folders the parent folders", async () => {
  const { addPicked } = await import("../../src/config/settings");
  const path = join(dir, "picked.json");
  writeFileSync(path, JSON.stringify({ repoRoots: [], repoPaths: [] }));
  const cfg = loadConfig(path);
  expect(addPicked(cfg, [`${reposRoot}/`, join(reposRoot, "web")], path)).toEqual([]);
  expect([cfg.repoRoots, cfg.repoPaths]).toEqual([[reposRoot], [join(reposRoot, "web")]]);
  expect(addPicked(cfg, [join(dir, "empty-nothing-here")], path)[0]).toContain("doesn't exist");
});

test("section saves preserve unrelated values and unknown config keys", () => {
  const path = join(dir, "sections.json");
  writeFileSync(path, JSON.stringify({ repoRoots: [reposRoot], pickupStates: ["Ready"], pollIntervalSeconds: 300, launch: { launcher: "superset", supersetBin: "/custom/superset" }, custom: 42 }));
  const cfg = loadConfig(path);
  const res = saveSettings(cfg, form({ section: "ai", provider: "cli", model: "new-model", lowConfidenceThreshold: "0.8", launcher: "git", pickupStates: "Other" }), path);
  expect(res.errors).toEqual([]);
  expect(cfg.llm.model).toBe("new-model");
  expect(cfg.launch.launcher).toBe("superset");
  expect(cfg.pickupStates).toEqual(["Ready"]);
  expect(cfg.repoRoots).toEqual([reposRoot]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ custom: 42, launch: { supersetBin: "/custom/superset" } });
});

test("repository saves preserve overrides while optional catalogue controls are loading", () => {
  const path = join(dir, "repo-draft.json");
  writeFileSync(path, JSON.stringify({ repoRoots: [reposRoot], repos: { api: { exclude: true, description: "Keep this" } } }));
  const cfg = loadConfig(path);
  expect(saveSettings(cfg, form({ section: "repositories", repoRoots: reposRoot, repoPaths: "" }), path).errors).toEqual([]);
  expect(cfg.repos.api).toEqual({ exclude: true, description: "Keep this" });
});

test("empty selected statuses cannot accidentally enable watching every open ticket", () => {
  const path = join(dir, "status-mode.json");
  writeFileSync(path, JSON.stringify({ pickupStates: ["Ready"] }));
  const cfg = loadConfig(path);
  const fields = { section: "tickets", pickupMode: "selected", pollMinutes: "5", workMinutes: "2" };
  expect(saveSettings(cfg, form(fields), path).fields?.pickupMode).toContain("Choose at least one");
  expect(cfg.pickupStates).toEqual(["Ready"]);
  expect(saveSettings(cfg, form({ ...fields, pickupMode: "any", pickupStates: "Ready" }), path).errors).toEqual([]);
  expect(cfg.pickupStates).toEqual([]);
});

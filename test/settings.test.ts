import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { saveSettings } from "../src/settings";

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
  pollMinutes: "15", workMinutes: "2", reposRoot, launcher: "worktrunk", terminal: "iterm", worktreesDir: "",
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
  const res = saveSettings(loadConfig(configPath), form({ ...valid, pollMinutes: "0", reposRoot: "/nope", launcher: "emacs" }), configPath);
  expect(res.errors.join(" ")).toContain("Poll interval");
  expect(res.errors.join(" ")).toContain("doesn't exist");
  expect(res.errors.join(" ")).toContain("launcher");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("specific-repo mode and ticket prefixes are validated and saved", () => {
  const elsewhere = join(dir, "elsewhere", "api");
  mkdirSync(join(elsewhere, ".git"), { recursive: true });
  const cfg = loadConfig(configPath);
  const bad = saveSettings(cfg, form({ ...valid, repoMode: "list", repoPaths: `${elsewhere}\n${join(dir, "nope")}`, ticketPrefixes: "eng, 9x" }), configPath);
  expect(bad.errors.join(" ")).toContain("isn't a git repo");
  expect(bad.errors.join(" ")).toContain('Ticket prefix "9X"');

  const ok = saveSettings(cfg, form({ ...valid, repoMode: "list", repoPaths: `${elsewhere}\n${join(reposRoot, "api")}`, ticketPrefixes: "eng it" }), configPath);
  expect(ok.errors).toEqual([]);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  expect(raw.repoMode).toBe("list");
  expect(raw.ticketPrefixes).toEqual(["ENG", "IT"]);
  expect(cfg.repoPaths).toEqual([elsewhere, join(reposRoot, "api")]);
});

test("repo list mode names same-named repos distinctly", async () => {
  const { repoSources } = await import("../src/catalog");
  const cfg = loadConfig(configPath);
  expect(repoSources(cfg).map((r) => r.name)).toEqual(["api", "code-api"]);
});

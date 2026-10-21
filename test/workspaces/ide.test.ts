import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ideChatUrl, ideWorkspace } from "../../src/workspaces/launch";
import { loadConfig } from "../../src/config/config";
import { Health } from "../../src/app/health";

const dir = mkdtempSync(join(tmpdir(), "autopilot-ide-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("chat links: VS Code → Claude extension; Cursor → its own chat or the Claude extension", () => {
  const prompt = "Read the ticket brief at /a b/ENG-1-brief.md & go";
  const enc = encodeURIComponent(prompt);
  expect(ideChatUrl("vscode", "cursor", prompt)).toBe(`vscode://anthropic.claude-code/open?prompt=${enc}`);
  expect(ideChatUrl("cursor", "cursor", prompt)).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${enc}`);
  expect(ideChatUrl("cursor", "claude", prompt)).toBe(`cursor://anthropic.claude-code/open?prompt=${enc}`);
  expect(enc).toContain("%26"); // "&" can't truncate the prompt
});

test("IDE brief lives inside the primary worktree (git-ignored); several repos get a workspace file there", async () => {
  const repo = join(dir, "api");
  Bun.spawnSync(["git", "init", "-q", repo]);
  const briefPath = join(dir, "ENG-1.md");
  writeFileSync(briefPath, "# brief");
  const req = { identifier: "ENG-1", briefPath, others: [], primaryPath: repo, otherPaths: [] as string[], prompt: "", addDirs: [], background: false };

  const single = await ideWorkspace(req);
  expect(single.target).toBe(repo); // one repo: open the folder itself
  expect(single.brief).toBe(join(repo, ".autopilot", "ENG-1-brief.md"));
  expect(readFileSync(single.brief, "utf8")).toBe("# brief");
  expect(statSync(single.brief).mode & 0o222).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]).stdout.toString()).toBe(""); // excluded from git

  const multi = await ideWorkspace({ ...req, others: [{ repo: "web", path: "/wt/web/x" }], otherPaths: ["/wt/web/x"] });
  expect(multi.target).toBe(join(repo, ".autopilot", "ENG-1.code-workspace"));
  expect(JSON.parse(readFileSync(multi.target, "utf8")).folders).toEqual([{ path: repo }, { path: "/wt/web/x" }]);
  expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".autopilot/")).toHaveLength(1);
});

test("non-Supacode launchers get a small, dismissible 'works best with Supacode' hint", async () => {
  const base = loadConfig("/nonexistent");
  const items = await new Health({ ...base, launch: { ...base.launch, launcher: "git", terminal: "none" } }).refresh();
  const hint = items.find((i) => i.id === "supacode-hint");
  expect(hint?.level).toBe("hint");
  const installed = existsSync("/Applications/supacode.app") || existsSync(base.launch.supacodeBin);
  expect(!!hint?.link).toBe(!installed); // the "Get Supacode" link only when it's missing
  expect((await new Health(base).refresh()).some((i) => i.id === "supacode-hint")).toBe(false); // already on Supacode
});

test("reads the editor's trusted folders (read-only), honouring parent folders", async () => {
  const { editorTrusts } = await import("../../src/app/health");
  const db = join(dir, "state.vscdb");
  const trust = JSON.stringify({
    uriTrustInfo: [
      { uri: { $mid: 1, scheme: "file", path: "/Users/me/code/wt" }, trusted: true },
      { uri: "file:///Users/me/other", trusted: true },
      { uri: { scheme: "file", path: "/Users/me/untrusted" }, trusted: false },
    ],
  });
  Bun.spawnSync(["sqlite3", db, "create table ItemTable (key text primary key, value blob);"]);
  Bun.spawnSync(["sqlite3", db, `insert into ItemTable values ('content.trust.model.key', '${trust.replace(/'/g, "''")}');`]);
  expect(editorTrusts("vscode", "/Users/me/code/wt", db)).toBe(true);
  expect(editorTrusts("vscode", "/Users/me/code/wt/main/fix-eng-1", db)).toBe(true); // inside a trusted parent
  expect(editorTrusts("vscode", "/Users/me/other/x", db)).toBe(true); // string form
  expect(editorTrusts("vscode", "/Users/me/untrusted", db)).toBe(false);
  expect(editorTrusts("vscode", "/Users/me/code/wtx", db)).toBe(false); // prefix, not a parent
  expect(editorTrusts("vscode", "/x", join(dir, "missing.vscdb"))).toBe(false);
});

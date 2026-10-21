import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config";
import { supacodeId } from "../../src/domain/worktree";
import { ticketComponents } from "../../src/web/views/components/tickets";
import { renderPage } from "../../src/web/views/layout";
import { csrfField } from "../../src/web/views/forms";
import type { TicketViewData } from "../../src/web/models";
import { issue, work } from "../fixtures/issues";

const data = (): TicketViewData => ({
  cfg: loadConfig("/nonexistent"), trackerLabel: "Linear", tokenField: csrfField("test-token"),
  catalog: [{ name: "api", path: "/code/api", description: "API", topLevel: [] }, { name: "web", path: "/code/web", description: "UI", topLevel: [] }],
  steps: new Map(), notes: new Map(), worktreeLinks: new Map(),
});

test("ticket templates render snapshots without a database, launcher or HTTP server", () => {
  const snapshot = data();
  const row = issue({ title: '<img src=x onerror="bad">', confidence: 0.2 });
  const before = structuredClone({ snapshot, row });
  const { card, modal } = ticketComponents(snapshot);
  expect(card(row)).toContain('href="#m-ENG-1">Review</a>');
  expect(card(row)).not.toContain('action="/issues/ENG-1/approve"');
  expect(modal(row)).toContain('action="/issues/ENG-1/approve"');
  expect(modal(row)).toContain('value="web"');
  expect(modal(row)).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  expect(modal(row)).toContain('name="csrf" value="test-token"');
  expect({ snapshot, row }).toEqual(before);
});

test("running multi-repo tickets use supplied links and expose safety warnings", () => {
  const snapshot = data();
  snapshot.worktreeLinks = new Map([["ticket-1", new Map([["/work/api", "vscode://file/work/api"]])]]);
  const row = issue({
    status: "running", launcher: "vscode", worktree_id: supacodeId("/work/api"),
    extra_repos_json: JSON.stringify([{ repo: "web", repo_path: "/code/web", reason: "UI", worktree_id: supacodeId("/work/web") }]),
    work_json: JSON.stringify([
      work({ dirtyFiles: 2, pr: { number: 12, url: "https://example.test/pr/12", state: "OPEN", isDraft: false, title: "Fix API" } }),
      work({ repo: "web", worktreePath: "/work/web", unpushed: 1 }),
    ]),
  });
  const { workCard, modal } = ticketComponents(snapshot);
  expect(workCard(row)).toContain('href="vscode://file/work/api"');
  expect(workCard(row)).toContain("api PR #12");
  expect(workCard(row)).toContain("Send prompt to chat");
  expect(modal(row)).toContain("api: 2 uncommitted files");
  expect(modal(row)).toContain("web: 1 unpushed commit");
  expect(modal(row)).toContain('name="force"');
});

test("launch steps and imported tickets without worktrees render from data alone", () => {
  const snapshot = data();
  snapshot.steps = new Map([["ENG-1", "Creating worktree…"]]);
  const { card, workCard, modal } = ticketComponents(snapshot);
  expect(card(issue({ status: "approved" }))).toContain("Creating worktree…");
  expect(card(issue({ status: "approved" }))).not.toContain('action="/issues/ENG-1/approve"');
  const imported = issue({ status: "running", repo: "", repo_path: "" });
  expect(workCard(imported)).toContain("No worktree found for this ticket");
  expect(modal(imported)).not.toContain("Delete worktree");
});

test("page layout embeds CSS and exactly one nonce-bearing executable browser script", () => {
  const html = renderPage("<title>", "<h1>Hello</h1>", "test-nonce");
  expect(html).toContain("<title>&lt;title&gt;</title>");
  expect(html).toContain("<style>");
  expect(html).toContain('<script nonce="test-nonce">');
  expect(html.match(/<script/g)).toHaveLength(1);
  const script = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)![1];
  expect(() => new Function(script)).not.toThrow(); // parse only, never execute in the test process
});

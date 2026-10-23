import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config";
import { worktreeId } from "../../src/domain/worktree";
import { ticketComponents } from "../../src/web/views/components/tickets";
import { renderPage } from "../../src/web/views/layout";
import { csrfField } from "../../src/web/views/forms";
import type { TicketViewData } from "../../src/web/models";
import { issue, work } from "../fixtures/issues";

const data = (): TicketViewData => ({
  cfg: loadConfig("/nonexistent"), trackerLabel: "Linear", tokenField: csrfField("test-token"),
  catalog: [{ name: "api", path: "/code/api", description: "API", topLevel: [] }, { name: "web", path: "/code/web", description: "UI", topLevel: [] }],
  steps: new Map(), notes: new Map(), worktreeLinks: new Map(), canResendPrompt: false,
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

test("the existing triage box is editable and launch controls submit the same draft", () => {
  const snapshot = data();
  const values = { summary: '</textarea><script>alert("x")</script>', approach: "First line\nSecond line", likely_areas: ["src/a.ts", "test/a.test.ts"], size: "M" };
  const row = issue({ explainer_json: JSON.stringify(values) });
  const views = ticketComponents(snapshot);
  const html = views.modal(row);
  expect(html).toContain('action="/issues/ENG-1/edit-triage" data-triage-edit');
  expect(html).toContain('name="expected"');
  expect(html).toContain('name="csrf" value="test-token"');
  expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
  expect(html).not.toContain('<script>alert("x")');
  expect(html).toContain("src/a.ts\ntest/a.test.ts");
  expect(html).toContain('<option value="M" selected>M</option>');
  expect(html).not.toContain("Edit triage");
  expect(html).not.toContain('<p class="triage-text"');
  expect(html).toContain('>Update</button>');
  expect(html.match(/name="summary"/g)).toHaveLength(1);
  expect(html).toContain('<form id="triage-ENG-1"');
  expect(html).toContain('name="repo" form="triage-ENG-1"');
  expect(html).toContain('name="extra" value="web" form="triage-ENG-1"');
  expect(html).toContain('name="branch" value="fix-widget-eng-1" form="triage-ENG-1"');
  expect(html).toContain('form="triage-ENG-1" formaction="/issues/ENG-1/approve"');
  expect(html).toContain('formaction="/issues/ENG-1/reject" formnovalidate data-skip-triage');
  expect(views.modal({ ...row, status: "approved" })).not.toContain("data-triage-edit");
  expect(views.modal({ ...row, status: "running" })).toContain(">Update</button>");
});

test("running multi-repo tickets use supplied links and expose safety warnings", () => {
  const snapshot = data();
  snapshot.canResendPrompt = true;
  snapshot.worktreeLinks = new Map([["ticket-1", new Map([["/work/api", "vscode://file/work/api"]])]]);
  const row = issue({
    status: "running", launcher: "vscode", worktree_id: worktreeId("/work/api"),
    extra_repos_json: JSON.stringify([{ repo: "web", repo_path: "/code/web", reason: "UI", worktree_id: worktreeId("/work/web") }]),
    work_json: JSON.stringify([
      work({ dirtyFiles: 2, pr: { number: 12, url: "https://example.test/pr/12", state: "OPEN", isDraft: false, title: "Fix API" } }),
      work({ repo: "web", worktreePath: "/work/web", unpushed: 1 }),
    ]),
  });
  const { workCard, modal } = ticketComponents(snapshot);
  expect(workCard(row)).toContain('href="vscode://file/work/api"');
  expect(workCard(row)).toContain('href="https://example.test/pr/12"');
  expect(workCard(row)).toContain("PR #12");
  expect(modal(row)).toContain("Send prompt to chat");
  expect(modal(row)).toContain("api: 2 uncommitted files");
  expect(modal(row)).toContain("web: 1 unpushed commit");
  expect(modal(row)).toContain('name="force"');
  expect(modal({ ...row, launcher: "superset" })).toContain("using the selected launcher");
  expect(modal({ ...row, launcher: "superset" })).not.toContain("through Supacode");
});

test("failed work checks never imply that a worktree is clean or has zero commits", () => {
  const { workCard } = ticketComponents(data());
  const html = workCard(issue({ status: "running", worktree_id: worktreeId("/work/api"), work_json: JSON.stringify([
    work({ commitsAhead: null, dirtyFiles: null, error: "Could not inspect worktree" }),
  ]) }));
  expect(html).toContain("Commits unavailable");
  expect(html).toContain("1 check error");
  expect(html).not.toContain(">Clean<");
  expect(html).not.toContain("<b>0</b> commits");
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

test("tickets omit manual triage, session and launcher setup controls while retaining setup progress and errors", () => {
  const snapshot = data();
  const row = issue({ status: "running", triage_source: null, repo: "", repo_path: "" });
  const views = ticketComponents(snapshot);
  const existing = { ...row, worktree_id: worktreeId("/work/api"), repo: "api", launcher: "supacode" };
  snapshot.cfg.launch.launcher = "superset";
  for (const ticket of [row, existing, { ...existing, triage_source: "automatic" as const }, { ...existing, linear_state_type: "completed" }]) {
    for (const html of [views.workCard(ticket), views.modal(ticket)]) {
      for (const action of ["triage", "open-session", "configure-launcher"]) expect(html).not.toContain(`/issues/ENG-1/${action}`);
    }
  }
  snapshot.steps = new Map([[row.identifier, "Configuring superset…"]]);
  expect(views.workCard(existing)).toContain("Configuring superset…");
  expect(views.modal(existing)).toContain("Configuring superset…");
  snapshot.steps = new Map();
  snapshot.notes = new Map([[row.identifier, { level: "error", msg: "<Host unavailable> Launcher setup will retry automatically." }]]);
  expect(views.modal(existing)).toContain("&lt;Host unavailable&gt; Launcher setup will retry automatically.");
});

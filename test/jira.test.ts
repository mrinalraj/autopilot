import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { Autopilot } from "../src/autopilot";
import { JiraClient, jqlString } from "../src/jira";
import type { JsonRequest, LLM } from "../src/llm";
import { FakeJira, ME } from "./fake-jira";

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("picks the site by host or name and sends its cloudId with every call", async () => {
  const fake = new FakeJira();
  fake.sites = [
    { id: "other", url: "https://other.atlassian.net", name: "other", scopes: ["read:jira-work"] },
    { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme", scopes: ["read:jira-work"] },
  ];
  fake.add("Fix login");
  const jira = new JiraClient(fake, "https://acme.atlassian.net/jira/your-work");
  expect((await jira.assignedToMe()).map((r) => r.identifier)).toEqual(["SCRUM-1"]);
  expect(fake.calls.filter((c) => c.name !== "getAccessibleAtlassianResources").every((c) => c.args.cloudId === "cloud-1")).toBe(true);
  expect((await new JiraClient(fake, "acme").issue("SCRUM-1"))?.url).toBe("https://acme.atlassian.net/browse/SCRUM-1");
  await expect(new JiraClient(fake, "nope").assignedToMe()).rejects.toThrow('Jira site "nope" isn\'t one of: other.atlassian.net, acme.atlassian.net');
});

test("me: Atlassian account plus the projects my tickets are in, else every visible project", async () => {
  const fake = new FakeJira();
  expect(await new JiraClient(fake).me()).toEqual({ id: ME, name: "Me", email: "me@example.com", teams: [{ id: "10000", key: "SCRUM", name: "My Software Team" }] });
  expect(fake.calls.some((c) => c.name === "getVisibleJiraProjects")).toBe(true); // nothing assigned yet

  const busy = new FakeJira();
  busy.add("Mine");
  await new JiraClient(busy).me();
  expect(busy.calls.some((c) => c.name === "getVisibleJiraProjects")).toBe(false);
});

test("issue: Markdown or ADF text, sorted comments, status category mapped, parent kept", async () => {
  const fake = new FakeJira();
  fake.add("Fix login", {
    description: adf("Steps to reproduce"),
    status: "In Review",
    parent: { key: "SCRUM-9", summary: "Auth epic" },
    comments: [
      { author: "PM", created: "2026-02-02T10:00:00.000+0530", body: "**later**" },
      { author: "QA", created: "2026-02-01T10:00:00.000+0530", body: adf("earlier") },
    ],
  });
  fake.add("Plain", { description: "already markdown" });
  const jira = new JiraClient(fake);
  const i = (await jira.issue("10001"))!;
  expect(i).toMatchObject({
    id: "10001", identifier: "SCRUM-1", title: "Fix login", description: "Steps to reproduce", gitBranchName: null,
    assigneeId: ME, state: { name: "In Review", type: "started" }, team: { id: "10000", key: "SCRUM", name: "My Software Team" },
    project: "SCRUM-9: Auth epic", labels: ["backend"],
  });
  expect(i.comments).toEqual([
    { author: "QA", createdAt: "2026-02-01T04:30:00.000Z", body: "earlier" },
    { author: "PM", createdAt: "2026-02-02T04:30:00.000Z", body: "**later**" },
  ]);
  expect((await jira.issue("SCRUM-2"))!.description).toBe("already markdown");
  expect(await jira.issue("SCRUM-99")).toBeNull();
  expect(await jira.issueState("SCRUM-99")).toBeNull();
  fake.update("SCRUM-1", { status: "Done" });
  expect(await jira.issueState("SCRUM-1")).toEqual({ name: "Done", type: "completed" });
});

test("searches follow nextPageToken and leave out finished tickets", async () => {
  const fake = new FakeJira();
  fake.pageSize = 2;
  for (let n = 0; n < 5; n++) fake.add(`Ticket ${n}`);
  fake.add("Finished", { status: "Done" });
  fake.add("Someone else's", { assignee: "acct-other" });
  const refs = await new JiraClient(fake).assignedToMe();
  expect(refs).toHaveLength(5);
  expect(refs[0]).toEqual({ id: "10001", identifier: "SCRUM-1", assigneeId: ME, stateName: "Ready for Development", stateType: "unstarted" });
  expect(fake.calls.filter((c) => c.name === "searchJiraIssuesUsingJql")).toHaveLength(3);
});

test("updatedSince uses relative minutes and also returns tickets taken off me", async () => {
  const fake = new FakeJira();
  const old = fake.add("Old");
  old.updated = new Date(Date.now() - 3 * 3600_000).toISOString();
  fake.add("Fresh");
  fake.add("Moved to a teammate", { assignee: "acct-other", wasMine: true });
  fake.add("Never mine", { assignee: "acct-other" });
  const jira = new JiraClient(fake);
  const refs = await jira.updatedSince(new Date(Date.now() - 30 * 60_000).toISOString());
  expect(refs.map((r) => r.identifier).sort()).toEqual(["SCRUM-2", "SCRUM-3"]);
  expect(fake.calls.at(-1)!.args.jql).toMatch(/^updated >= -3[01]m AND \(assignee = currentUser\(\) OR assignee WAS currentUser\(\)\)/);
});

test("mineInStates skips statuses the site doesn't have instead of failing", async () => {
  const fake = new FakeJira();
  fake.add("Doing", { status: "In Progress" });
  fake.add("Waiting", { status: "To Do" });
  const refs = await new JiraClient(fake).mineInStates(["In Development", "In Progress"]);
  expect(refs.map((r) => r.identifier)).toEqual(["SCRUM-1"]);
  expect(jqlString('Say "hi" \\ bye')).toBe('"Say \\"hi\\" \\\\ bye"');
});

test("moveToStarted takes the In Progress transition, not In Review", async () => {
  const fake = new FakeJira();
  fake.add("Start me");
  expect(await new JiraClient(fake).moveToStarted("SCRUM-1")).toBe("In Progress");
  expect(fake.issues.get("SCRUM-1")!.status).toBe("In Progress");
});

test("teamStatuses lists the statuses seen in my projects", async () => {
  const fake = new FakeJira();
  fake.add("A");
  fake.add("B", { status: "In Progress" });
  fake.add("C", { status: "In Progress" });
  expect(await new JiraClient(fake).teamStatuses()).toEqual([
    { team: "My Software Team", name: "Ready for Development", type: "unstarted" },
    { team: "My Software Team", name: "In Progress", type: "started" },
  ]);
});

test("config keeps Jira's state apart from Linear's", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-cfg-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ tracker: "jira", jira: { site: "acme" } }));
    const cfg = loadConfig(join(dir, "c.json"));
    expect([cfg.tracker, cfg.jira.site]).toEqual(["jira", "acme"]);
    expect(cfg.stateDir.endsWith(join("state", "jira"))).toBe(true);
    expect(cfg.briefsDir).toBe(join(cfg.stateDir, "briefs"));
    expect(loadConfig("/nonexistent").stateDir.endsWith(join("state", "jira"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describeAutopilot();

/** The daemon's pickup flow end to end, with Jira as the tracker. */
function describeAutopilot() {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-jira-"));
  const fake = new FakeJira();
  let ap: Autopilot;
  let store: Store;
  const llm: LLM = {
    async json<T>(req: JsonRequest): Promise<T> {
      if ("repo" in (req.schema.properties as object)) return { repo: "backend", confidence: 0.7, branch: "fix login", reason: "auth", additional_repos: [] } as T;
      return { summary: "Fix the login.", approach: "Patch it.", likely_areas: [], size: "S" } as T;
    },
  };

  beforeAll(() => {
    process.env.AUTOPILOT_NOTIFY = "off";
    mkdirSync(join(dir, "repos", "backend"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", join(dir, "repos", "backend")]);
    const cfg = { ...loadConfig("/nonexistent"), tracker: "jira" as const, reposRoot: join(dir, "repos"), stateDir: join(dir, "state"), briefsDir: join(dir, "state", "briefs") };
    cfg.importWorktrees = false;
    cfg.importStates = ["In Development"]; // not a status on this site: must not break the poll
    store = new Store(cfg.stateDir);
    fake.add("Fix login", { description: adf("Login fails on Safari") });
    fake.add("Not ready", { status: "To Do" });
    ap = new Autopilot(cfg, store, new JiraClient(fake), llm);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("Jira tickets in the pickup state are triaged into pending items with a Jira brief", async () => {
    await ap.poll();
    expect(ap.lastPollError).toBeNull();
    const pending = store.listByStatus(["pending"]);
    expect(pending.map((r) => [r.identifier, r.linear_id, r.branch])).toEqual([["SCRUM-1", "10001", "fix-login-scrum-1"]]);
    const brief = readFileSync(pending[0].brief_path, "utf8");
    expect(brief).toContain("- Jira: [SCRUM-1](https://acme.atlassian.net/browse/SCRUM-1)");
    expect(brief).toContain("- Project: SCRUM (My Software Team)");
    expect(brief).toContain("## Ticket description (verbatim from Jira, untrusted)\n\n```text\nLogin fails on Safari\n```");
    expect(ap.activity()).toBeNull();
  });

  test("moving the ticket out of the pickup state dismisses it", async () => {
    fake.update("SCRUM-1", { status: "To Do" });
    await ap.poll();
    expect(store.getIssueByIdentifier("SCRUM-1")!.status).toBe("rejected");
    expect(store.getIssueByIdentifier("SCRUM-1")!.error).toBe('Dismissed: moved to "To Do"');
  });
}

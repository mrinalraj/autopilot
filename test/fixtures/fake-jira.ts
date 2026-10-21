import type { Json, ToolCaller } from "../../src/trackers/mcp";

/**
 * Atlassian's MCP tools over an in-memory Jira, returning the REST shapes the real server sends
 * (recorded from a live site). Understands only the JQL the client builds, and fails a query
 * naming an unknown status the way Jira does.
 */

export interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  description: Json | string | null;
  status: string;
  assignee: string | null;
  /** Ever assigned to `ME` (for `assignee WAS currentUser()`). */
  wasMine: boolean;
  updated: string;
  comments: { author: string; created: string; body: Json | string }[];
  parent?: { key: string; summary: string };
}

export const ME = "acct-me";
const CATEGORY: Record<string, string> = { "To Do": "new", "Ready for Development": "new", "In Progress": "indeterminate", "In Review": "indeterminate", Done: "done" };

export class FakeJira implements ToolCaller {
  issues = new Map<string, FakeIssue>();
  calls: { name: string; args: Json }[] = [];
  /** Issues per search page, to exercise nextPageToken. */
  pageSize = 100;
  sites: Json[] = [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "acme", scopes: ["read:jira-work", "write:jira-work"] }];
  statuses = new Set(Object.keys(CATEGORY));

  add(summary: string, opts: Partial<FakeIssue> = {}): FakeIssue {
    const n = this.issues.size + 1;
    const issue: FakeIssue = {
      id: String(10000 + n), key: `SCRUM-${n}`, summary, description: null, status: "Ready for Development",
      assignee: ME, wasMine: false, updated: new Date().toISOString(), comments: [], ...opts,
    };
    issue.wasMine ||= issue.assignee === ME;
    this.issues.set(issue.key, issue);
    return issue;
  }

  update(key: string, patch: Partial<FakeIssue>) {
    const i = this.issues.get(key)!;
    Object.assign(i, patch, { updated: new Date().toISOString() });
    i.wasMine ||= i.assignee === ME;
  }

  private find(idOrKey: string) {
    return this.issues.get(idOrKey) ?? [...this.issues.values()].find((i) => i.id === idOrKey);
  }

  private status(name: string) {
    return { name, id: name, statusCategory: { key: CATEGORY[name] ?? "new", name } };
  }

  private rest(i: FakeIssue, fields: string[] = []) {
    const all = !fields.length;
    const has = (f: string) => all || fields.includes(f);
    const f: Json = {};
    if (has("summary")) f.summary = i.summary;
    if (has("description")) f.description = i.description ?? { type: "doc", version: 1, content: [] };
    if (has("status")) f.status = this.status(i.status);
    if (has("assignee")) f.assignee = i.assignee ? { accountId: i.assignee, displayName: "Someone" } : null;
    if (has("project")) f.project = { id: "10000", key: "SCRUM", name: "My Software Team" };
    if (has("labels")) f.labels = ["backend"];
    if (has("updated")) f.updated = i.updated.replace("Z", "+0000");
    if (has("attachment")) f.attachment = [];
    if (has("comment")) f.comment = { comments: i.comments.map((c) => ({ author: { displayName: c.author }, created: c.created, body: c.body })) };
    if (has("parent")) f.parent = i.parent ? { key: i.parent.key, fields: { summary: i.parent.summary } } : null;
    return { id: i.id, key: i.key, self: `https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/${i.id}`, fields: f };
  }

  private fail(name: string, message: string): never {
    throw new Error(`Jira ${name}: ${JSON.stringify({ error: true, message })}`);
  }

  private matches(i: FakeIssue, jql: string): boolean {
    const where = jql.replace(/ORDER BY.*$/i, "");
    if (!where.trim()) this.fail("searchJiraIssuesUsingJql", "Unbounded JQL queries are not allowed here.");
    let rest = where;
    if (/\(assignee = currentUser\(\) OR assignee WAS currentUser\(\)\)/.test(rest)) {
      if (i.assignee !== ME && !i.wasMine) return false;
      rest = rest.replace(/\(assignee = currentUser\(\) OR assignee WAS currentUser\(\)\)/, "");
    }
    if (/assignee = currentUser\(\)/.test(rest) && i.assignee !== ME) return false;
    if (/statusCategory != Done/.test(rest) && CATEGORY[i.status] === "done") return false;
    const st = /status = "((?:[^"\\]|\\.)*)"/.exec(rest)?.[1];
    if (st !== undefined && i.status !== st) return false;
    const mins = /updated >= -(\d+)m/.exec(rest)?.[1];
    if (mins && Date.parse(i.updated) < Date.now() - Number(mins) * 60_000) return false;
    const proj = /project = "([^"]+)"/.exec(rest)?.[1];
    if (proj && !i.key.startsWith(`${proj}-`)) return false;
    return true;
  }

  async call(name: string, args: Json): Promise<any> {
    this.calls.push({ name, args });
    if (name !== "getAccessibleAtlassianResources" && name !== "atlassianUserInfo" && args.cloudId !== "cloud-1") this.fail(name, "bad cloudId");
    switch (name) {
      case "getAccessibleAtlassianResources":
        return this.sites;
      case "atlassianUserInfo":
        return { account_id: ME, name: "Me", email: "me@example.com" };
      case "searchJiraIssuesUsingJql": {
        const st = /status = "((?:[^"\\]|\\.)*)"/.exec(args.jql)?.[1];
        if (st !== undefined && !this.statuses.has(st)) this.fail(name, `Bad Request. {"errorMessages":["The value '${st}' does not exist for the field 'status'."]}`);
        const hits = [...this.issues.values()].filter((i) => this.matches(i, args.jql));
        const start = Number(args.nextPageToken ?? 0);
        const page = hits.slice(start, start + this.pageSize);
        const more = start + this.pageSize < hits.length;
        return { issues: page.map((i) => this.rest(i, args.fields)), isLast: !more, ...(more ? { nextPageToken: String(start + this.pageSize) } : {}) };
      }
      case "getJiraIssue": {
        const i = this.find(args.issueIdOrKey);
        if (!i) this.fail(name, `{"errorMessages":["Issue does not exist or you do not have permission to see it."]}`);
        return this.rest(i, args.fields);
      }
      case "getVisibleJiraProjects":
        return { values: [{ id: "10000", key: "SCRUM", name: "My Software Team" }], isLast: true };
      case "getTransitionsForJiraIssue":
        return {
          transitions: ["To Do", "In Review", "In Progress", "Done"].map((s, n) => ({ id: String(11 + n * 10), name: s, to: this.status(s) })),
        };
      case "transitionJiraIssue": {
        const i = this.find(args.issueIdOrKey)!;
        const to = { "11": "To Do", "21": "In Review", "31": "In Progress", "41": "Done" }[args.transition.id as string]!;
        this.update(i.key, { status: to });
        return {};
      }
      default:
        this.fail(name, `Tool ${name} not found`);
    }
  }

  async reset() {}
  async close() {}
}

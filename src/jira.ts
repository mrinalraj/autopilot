import { toMarkdown } from "./adf";
import type { Json, ToolCaller } from "./mcp";
import type { IssueRef, Me, Tracker, TrackerIssue } from "./tracker";

/**
 * Jira Cloud through Atlassian's hosted MCP server (https://mcp.atlassian.com/v1/mcp). Every tool
 * takes the site's cloudId; responses are Jira REST shapes. Rich text is requested as Markdown,
 * but empty fields still arrive as ADF, so everything goes through `toMarkdown`.
 */

/** Jira's three status categories, in the Linear vocabulary the rest of the app uses. */
const CATEGORY: Record<string, string> = { new: "unstarted", indeterminate: "started", done: "completed" };
export const stateType = (status: Json | null | undefined): string => CATEGORY[status?.statusCategory?.key ?? ""] ?? "unstarted";

/** A JQL string literal. */
export const jqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const REF_FIELDS = ["status", "assignee"];
const FULL_FIELDS = ["summary", "description", "status", "assignee", "project", "labels", "updated", "attachment", "comment", "parent"];
const MISSING = /does not exist|not found|\b404\b/i;

export class JiraClient implements Tracker {
  readonly kind = "jira";
  readonly label = "Jira";
  private site: { id: string; url: string } | null = null;
  private meCache: Me | null = null;

  /** `siteHint` picks a site by host, name or cloudId when the account reaches several. */
  constructor(
    private readonly mcp: ToolCaller,
    private readonly siteHint = "",
  ) {}

  private async cloud() {
    if (!this.site) {
      const res = await this.mcp.call("getAccessibleAtlassianResources", {});
      const sites = ((Array.isArray(res) ? res : res?.resources ?? []) as Json[]).filter(
        (s) => !Array.isArray(s.scopes) || s.scopes.some((x: string) => x.includes("jira")),
      );
      if (!sites.length) throw new Error("this Atlassian account can't reach any Jira site");
      const host = (u: string) => new URL(u).host.toLowerCase();
      const hint = this.siteHint.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const pick = hint
        ? sites.find((s) => [s.id, s.name, host(s.url)].some((v) => v?.toLowerCase() === hint || `${v}`.toLowerCase() === `${hint}.atlassian.net`))
        : sites[0];
      if (!pick) throw new Error(`Jira site "${this.siteHint}" isn't one of: ${sites.map((s) => host(s.url)).join(", ")}`);
      this.site = { id: pick.id, url: String(pick.url).replace(/\/$/, "") };
    }
    return this.site;
  }

  private async call(name: string, args: Json): Promise<Json> {
    return this.mcp.call(name, { cloudId: (await this.cloud()).id, ...args });
  }

  private async search(jql: string, fields: string[], maxPages: number): Promise<Json[]> {
    const out: Json[] = [];
    let next: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.call("searchJiraIssuesUsingJql", { jql, fields, maxResults: 100, responseContentFormat: "markdown", ...(next ? { nextPageToken: next } : {}) });
      out.push(...(res.issues ?? []));
      next = res.nextPageToken;
      if (!next || res.isLast) break;
    }
    return out;
  }

  private static ref(i: Json): IssueRef {
    return { id: String(i.id), identifier: i.key, assigneeId: i.fields?.assignee?.accountId ?? null, stateName: i.fields?.status?.name ?? "", stateType: stateType(i.fields?.status) };
  }

  async viewer() {
    const u = await this.mcp.call("atlassianUserInfo", {});
    return { id: u.account_id ?? u.accountId, name: u.name ?? u.displayName ?? "", email: u.email ?? u.emailAddress ?? null };
  }

  /** Me, with the projects my tickets are in as "teams" (or every visible project when I have none). */
  async me(): Promise<Me> {
    if (!this.meCache) {
      const viewer = await this.viewer();
      const teams = new Map<string, Me["teams"][number]>();
      for (const i of await this.search("assignee = currentUser() ORDER BY updated DESC", ["project"], 2)) {
        const p = i.fields?.project;
        if (p?.key) teams.set(p.key, { id: String(p.id), key: p.key, name: p.name ?? p.key });
      }
      if (!teams.size) {
        const res = await this.call("getVisibleJiraProjects", { action: "browse", maxResults: 50, expandIssueTypes: false });
        for (const p of res.values ?? []) teams.set(p.key, { id: String(p.id), key: p.key, name: p.name ?? p.key });
      }
      this.meCache = { ...viewer, teams: [...teams.values()] };
    }
    return this.meCache;
  }

  async assignedToMe(): Promise<IssueRef[]> {
    return (await this.search("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", REF_FIELDS, 40)).map(JiraClient.ref);
  }

  /** Relative minutes, so Jira's per-user timezone for absolute JQL dates doesn't matter. */
  async updatedSince(since: string): Promise<IssueRef[]> {
    const minutes = Math.max(1, Math.ceil((Date.now() - Date.parse(since)) / 60_000));
    const jql = `updated >= -${minutes}m AND (assignee = currentUser() OR assignee WAS currentUser()) ORDER BY updated DESC`;
    return (await this.search(jql, REF_FIELDS, 20)).map(JiraClient.ref);
  }

  async issue(idOrKey: string): Promise<TrackerIssue | null> {
    let i: Json;
    try {
      i = await this.call("getJiraIssue", { issueIdOrKey: idOrKey, fields: FULL_FIELDS, responseContentFormat: "markdown" });
    } catch (err) {
      if (MISSING.test((err as Error).message)) return null;
      throw err;
    }
    const f = i.fields ?? {};
    const comments = ((f.comment?.comments ?? i.comments ?? []) as Json[])
      .map((c) => ({ author: c.author?.displayName ?? "unknown", createdAt: new Date(c.created).toISOString(), body: toMarkdown(c.body) ?? "" }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const parent = f.parent ? `${f.parent.key}: ${f.parent.fields?.summary ?? ""}`.trim() : null;
    return {
      id: String(i.id),
      identifier: i.key,
      title: f.summary ?? "",
      description: toMarkdown(f.description),
      url: `${(await this.cloud()).url}/browse/${i.key}`,
      updatedAt: f.updated ? new Date(f.updated).toISOString() : new Date().toISOString(),
      gitBranchName: null,
      assigneeId: f.assignee?.accountId ?? null,
      state: { name: f.status?.name ?? "", type: stateType(f.status) },
      team: { id: String(f.project?.id ?? ""), key: f.project?.key ?? String(i.key).split("-")[0], name: f.project?.name ?? "" },
      project: parent,
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      attachments: ((f.attachment ?? []) as Json[]).map((a) => ({ title: a.filename ?? "attachment", url: a.content ?? "" })).filter((a) => a.url),
      comments,
    };
  }

  /** Queried one status at a time: JQL rejects the whole query if any status doesn't exist on the site. */
  async mineInStates(states: string[]): Promise<IssueRef[]> {
    const out: IssueRef[] = [];
    for (const state of states) {
      try {
        out.push(...(await this.search(`assignee = currentUser() AND status = ${jqlString(state)} ORDER BY updated DESC`, REF_FIELDS, 10)).map(JiraClient.ref));
      } catch (err) {
        if (!MISSING.test((err as Error).message)) throw err;
      }
    }
    return out;
  }

  async issueState(idOrKey: string): Promise<{ name: string; type: string } | null> {
    try {
      const i = await this.call("getJiraIssue", { issueIdOrKey: idOrKey, fields: ["status"] });
      return { name: i.fields?.status?.name ?? "", type: stateType(i.fields?.status) };
    } catch (err) {
      if (MISSING.test((err as Error).message)) return null;
      throw err;
    }
  }

  /** The MCP server has no statuses tool, so these are the statuses seen on each project's recent tickets. */
  async teamStatuses(): Promise<{ team: string; name: string; type: string }[]> {
    const out: { team: string; name: string; type: string }[] = [];
    for (const t of (await this.me()).teams) {
      const seen = new Set<string>();
      for (const i of await this.search(`project = ${jqlString(t.key)} ORDER BY updated DESC`, ["status"], 1)) {
        const s = i.fields?.status;
        if (!s?.name || seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ team: t.name, name: s.name, type: stateType(s) });
      }
    }
    return out;
  }

  /** Takes the transition into an in-progress status, preferring one named like "In Progress" over e.g. "In Review". */
  async moveToStarted(idOrKey: string): Promise<string> {
    const res = await this.call("getTransitionsForJiraIssue", { issueIdOrKey: idOrKey });
    const started = ((res.transitions ?? []) as Json[]).filter((t) => t.to?.statusCategory?.key === "indeterminate");
    const pick = started.find((t) => /progress|develop/i.test(t.to?.name ?? t.name)) ?? started.find((t) => !/review/i.test(t.to?.name ?? t.name)) ?? started[0];
    if (!pick) throw new Error(`no transition to an in-progress status from here`);
    await this.call("transitionJiraIssue", { issueIdOrKey: idOrKey, transition: { id: String(pick.id) } });
    return pick.to?.name ?? pick.name;
  }

  async resetAuth() {
    this.site = null;
    this.meCache = null;
    await this.mcp.reset();
  }

  async close() {
    await this.mcp.close();
  }
}

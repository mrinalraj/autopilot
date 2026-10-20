import type { Json, ToolCaller } from "./mcp";
import type { IssueRef, Me, Tracker, TrackerIssue } from "./tracker";

/**
 * Linear through its hosted MCP server (https://mcp.linear.app/mcp). Tool results are JSON text;
 * `list_issues` truncates descriptions, so full text comes from `get_issue`.
 */

export class LinearClient implements Tracker {
  readonly kind = "linear";
  readonly label = "Linear";

  constructor(private readonly mcp: ToolCaller) {}

  private call(name: string, args: Json): Promise<Json> {
    return this.mcp.call(name, args);
  }

  async close() {
    await this.mcp.close();
  }

  async viewer(): Promise<{ id: string; name: string; email: string | null }> {
    const u = await this.call("get_user", { query: "me" });
    return { id: u.id, name: u.name, email: u.email ?? null };
  }

  /** Drops the connection, cached credentials and cached user, e.g. after signing in or out. */
  async resetAuth() {
    this.meCache = null;
    await this.mcp.reset();
  }

  private async listAll(args: Json, maxPages: number): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.call("list_issues", { ...args, limit: 250, ...(cursor ? { cursor } : {}) });
      out.push(...(res.issues ?? []));
      if (!res.hasNextPage) break;
      cursor = res.cursor;
    }
    return out;
  }

  private static ref(i: Json): IssueRef {
    return { id: i.uuid, identifier: i.id, assigneeId: i.assigneeId ?? null, stateName: i.status ?? "", stateType: i.statusType ?? "" };
  }

  /** Every issue currently assigned to me (first-run baseline). */
  async assignedToMe(): Promise<IssueRef[]> {
    const rows = await this.listAll({ assignee: "me", fields: ["id", "uuid", "assigneeId", "status", "statusType"] }, 40);
    return rows.map(LinearClient.ref);
  }

  /**
   * Every issue in the workspace updated after `since`, with its assignee. Assigning or
   * unassigning bumps updatedAt, so one call catches both directions.
   */
  async updatedSince(since: string): Promise<IssueRef[]> {
    const rows = await this.listAll({ updatedAt: since, fields: ["id", "uuid", "assigneeId", "status", "statusType"] }, 20);
    return rows.map(LinearClient.ref);
  }

  /** Full issue with untruncated description and all comments. */
  async issue(id: string): Promise<TrackerIssue | null> {
    let i: Json;
    try {
      i = await this.call("get_issue", {
        id,
        fields: ["id", "uuid", "title", "description", "url", "updatedAt", "status", "statusType", "labels",
          "assigneeId", "team", "teamId", "project", "attachments", "gitBranchName"],
      });
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
    const comments: TrackerIssue["comments"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.call("list_comments", { issueId: i.uuid, limit: 250, orderBy: "createdAt", ...(cursor ? { cursor } : {}) });
      for (const c of res.comments ?? []) {
        comments.push({ author: c.author?.name ?? "unknown", createdAt: c.createdAt, body: c.body ?? "" });
      }
      if (!res.hasNextPage) break;
      cursor = res.cursor;
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      id: i.uuid,
      identifier: i.id,
      title: i.title ?? "",
      description: i.description || null,
      url: i.url,
      updatedAt: i.updatedAt,
      gitBranchName: i.gitBranchName ?? null,
      assigneeId: i.assigneeId ?? null,
      state: { name: i.status ?? "", type: i.statusType ?? "" },
      team: { id: i.teamId ?? "", key: String(i.id).split("-")[0], name: i.team ?? "" },
      project: i.project ?? null,
      labels: Array.isArray(i.labels) ? i.labels.map(String) : [],
      attachments: Array.isArray(i.attachments)
        ? i.attachments.map((a: Json) => ({ title: a.title ?? "link", url: a.url ?? "" })).filter((a: { url: string }) => a.url)
        : [],
      comments,
    };
  }

  private meCache: Me | null = null;

  /** The logged-in user and their teams (cached for the process lifetime). */
  async me(): Promise<Me> {
    if (!this.meCache) {
      const u = await this.call("get_user", { query: "me" });
      this.meCache = { id: u.id, name: u.name, email: u.email ?? null, teams: u.teams ?? [] };
    }
    return this.meCache;
  }

  /** My tickets currently in any of `states` (status names). */
  async mineInStates(states: string[]): Promise<IssueRef[]> {
    const out: IssueRef[] = [];
    for (const state of states) {
      const rows = await this.listAll({ assignee: "me", state, fields: ["id", "uuid", "assigneeId", "status", "statusType"] }, 10);
      out.push(...rows.map(LinearClient.ref));
    }
    return out;
  }

  /** Just the workflow status of one issue, for tracking launched and imported tickets. */
  async issueState(id: string): Promise<{ name: string; type: string } | null> {
    try {
      const i = await this.call("get_issue", { id, fields: ["id", "status", "statusType"] });
      return { name: i.status ?? "", type: i.statusType ?? "" };
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  /** Workflow statuses of every team I belong to, for the pickup-state picker. */
  async teamStatuses(): Promise<{ team: string; name: string; type: string }[]> {
    const out: { team: string; name: string; type: string }[] = [];
    for (const t of (await this.me()).teams) {
      const res = await this.call("list_issue_statuses", { team: t.id });
      for (const s of (Array.isArray(res) ? res : res.statuses ?? []) as { name: string; type: string }[]) {
        out.push({ team: t.name, name: s.name, type: s.type });
      }
    }
    return out;
  }

  /** Moves the issue to its team's started state (needs the "write" scope). */
  async moveToStarted(id: string): Promise<string> {
    const res = await this.call("save_issue", { id, state: "started" });
    return res.status ?? "started";
  }
}

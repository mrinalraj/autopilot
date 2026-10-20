import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { keychainGet, keychainSet } from "./keychain";

/**
 * Linear access through Linear's hosted MCP server (https://mcp.linear.app/mcp) with OAuth,
 * for workspaces that don't allow personal API keys. One browser login (`bun run login`)
 * registers a client and stores tokens in the Keychain; the SDK refreshes them after that.
 */

export const LINEAR_MCP_URL = new URL("https://mcp.linear.app/mcp");
const KEYCHAIN_ACCOUNT = "linear-mcp-oauth";

export interface LinearIssue {
  /** Linear UUID. */
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  assigneeId: string | null;
  state: { name: string; type: string };
  team: { id: string; key: string; name: string };
  project: string | null;
  labels: string[];
  attachments: { title: string; url: string }[];
  comments: { author: string; createdAt: string; body: string }[];
}

/** Minimal row used for assignment tracking. */
export interface IssueRef {
  id: string;
  identifier: string;
  assigneeId: string | null;
  stateName: string;
  stateType: string;
}

export const CLOSED_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);

export class LoginRequiredError extends Error {
  constructor() {
    super("Linear login required: run `bun run login` in the linear-autopilot directory");
  }
}

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** OAuth state persisted as one JSON blob in the Keychain. */
export class KeychainOAuthProvider implements OAuthClientProvider {
  private cache: StoredAuth | null = null;
  private readonly stateValue = randomBytes(16).toString("hex");

  constructor(
    private readonly redirect: string,
    private readonly scope: string,
    /** Called with the authorization URL; non-interactive callers throw LoginRequiredError. */
    private readonly onAuthorize: (url: URL) => void | Promise<void>,
  ) {}

  private async load(): Promise<StoredAuth> {
    this.cache ??= JSON.parse((await keychainGet(KEYCHAIN_ACCOUNT)) ?? "{}");
    return this.cache!;
  }

  private async save(patch: Partial<StoredAuth>) {
    this.cache = { ...(await this.load()), ...patch };
    await keychainSet(KEYCHAIN_ACCOUNT, JSON.stringify(this.cache));
  }

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "linear-autopilot (local)",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.scope,
    };
  }

  state() {
    return this.stateValue;
  }

  async clientInformation() {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    await this.save({ clientInformation });
  }

  async tokens() {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.save({ tokens });
  }

  async redirectToAuthorization(url: URL) {
    await this.onAuthorize(url);
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.save({ codeVerifier });
  }

  async codeVerifier() {
    const v = (await this.load()).codeVerifier;
    if (!v) throw new Error("no PKCE code verifier saved");
    return v;
  }
}

export function connectMcp(provider: OAuthClientProvider) {
  const transport = new StreamableHTTPClientTransport(LINEAR_MCP_URL, { authProvider: provider });
  const client = new Client({ name: "linear-autopilot", version: "0.1.0" });
  return { client, transport, connect: () => client.connect(transport) };
}

type Json = Record<string, any>;

export class LinearClient {
  private client: Client | null = null;

  constructor(private readonly provider: OAuthClientProvider) {}

  private async connected(): Promise<Client> {
    if (!this.client) {
      const { client, connect } = connectMcp(this.provider);
      await connect();
      this.client = client;
    }
    return this.client;
  }

  /** Calls an MCP tool and parses its JSON text result; reconnects once on a dropped session. */
  private async call(name: string, args: Json): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await (await this.connected()).callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
        const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
        if (res.isError) throw new Error(`Linear ${name}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
      } catch (err) {
        if (err instanceof LoginRequiredError || err instanceof UnauthorizedError) {
          this.client = null;
          throw new LoginRequiredError();
        }
        await this.client?.close().catch(() => {});
        this.client = null;
        if (attempt >= 1 || (err as Error).message.startsWith(`Linear ${name}:`)) throw err;
      }
    }
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  async viewer(): Promise<{ id: string; name: string }> {
    const u = await this.call("get_user", { query: "me" });
    return { id: u.id, name: u.name };
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
  async issue(id: string): Promise<LinearIssue | null> {
    let i: Json;
    try {
      i = await this.call("get_issue", {
        id,
        fields: ["id", "uuid", "title", "description", "url", "updatedAt", "status", "statusType", "labels",
          "assigneeId", "team", "teamId", "project", "attachments"],
      });
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
    const comments: LinearIssue["comments"] = [];
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

  /** Moves the issue to its team's started state (needs the "write" scope). */
  async moveToStarted(id: string): Promise<string> {
    const res = await this.call("save_issue", { id, state: "started" });
    return res.status ?? "started";
  }
}

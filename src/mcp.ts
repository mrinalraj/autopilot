import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { keychainGet, keychainSet } from "./keychain";
import { LoginRequiredError } from "./tracker";

/**
 * Trackers are reached through their hosted MCP servers with OAuth (dynamic client registration +
 * PKCE), for workspaces that don't allow personal API keys. One browser login registers a client
 * and stores tokens in the Keychain; the SDK refreshes them after that.
 */

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** OAuth state persisted as one JSON blob in the Keychain, one account per tracker. */
export class KeychainOAuthProvider implements OAuthClientProvider {
  private cache: StoredAuth | null = null;
  private readonly stateValue = randomBytes(16).toString("hex");

  constructor(
    private readonly account: string,
    private readonly redirect: string,
    private readonly scope: string | undefined,
    /** Called with the authorization URL; non-interactive callers throw LoginRequiredError. */
    private readonly onAuthorize: (url: URL) => void | Promise<void>,
  ) {}

  private async load(): Promise<StoredAuth> {
    this.cache ??= JSON.parse((await keychainGet(this.account)) ?? "{}");
    return this.cache!;
  }

  /** Forgets the in-memory copy so the next call re-reads the Keychain (after sign-in or sign-out). */
  reset() {
    this.cache = null;
  }

  private async save(patch: Partial<StoredAuth>) {
    this.cache = { ...(await this.load()), ...patch };
    await keychainSet(this.account, JSON.stringify(this.cache));
  }

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "autopilot (local)",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
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

export function connectMcp(url: URL, provider: OAuthClientProvider) {
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client({ name: "autopilot", version: "0.1.0" });
  return { client, transport, connect: () => client.connect(transport) };
}

export type Json = Record<string, any>;

/** Calls MCP tools by name; the trackers' clients depend on this, so tests can swap in a fake. */
export interface ToolCaller {
  call(name: string, args: Json): Promise<any>;
  /** Drops the connection and cached credentials. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A lazily connected MCP session whose tools return JSON text. */
export class McpSession implements ToolCaller {
  private client: Client | null = null;

  constructor(
    private readonly url: URL,
    private readonly provider: OAuthClientProvider,
    private readonly label: string,
  ) {}

  private async connected(): Promise<Client> {
    if (!this.client) {
      const { client, connect } = connectMcp(this.url, this.provider);
      await connect();
      this.client = client;
    }
    return this.client;
  }

  /** Calls a tool and parses its JSON text result; reconnects once on a dropped session. */
  async call(name: string, args: Json): Promise<any> {
    const prefix = `${this.label} ${name}:`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await (await this.connected()).callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
        const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
        if (res.isError) throw new Error(`${prefix} ${text.slice(0, 300)}`);
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${prefix} expected JSON, got: ${text.slice(0, 200)}`);
        }
      } catch (err) {
        if (err instanceof LoginRequiredError || err instanceof UnauthorizedError) {
          this.client = null;
          throw new LoginRequiredError(this.label);
        }
        await this.client?.close().catch(() => {});
        this.client = null;
        if (attempt >= 1 || (err as Error).message.startsWith(prefix)) throw err;
      }
    }
  }

  async reset() {
    (this.provider as { reset?: () => void }).reset?.();
    await this.close();
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

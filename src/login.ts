import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, oauthRedirectUrl, oauthScope, type Config } from "./config";
import { keychainDelete } from "./keychain";
import { connectMcp, KeychainOAuthProvider, LinearClient } from "./linear";

const KEYCHAIN_ACCOUNT = "linear-mcp-oauth";

/**
 * Browser login to Linear's MCP server (OAuth with PKCE). Opens the authorize page, waits up to
 * five minutes for the redirect on the loopback port, and stores tokens in the Keychain. `force`
 * discards stored credentials first (switching accounts, or adding the write scope).
 */
export async function browserLogin(
  cfg: Config,
  opts: { force?: boolean; onUrl?: (url: URL) => void } = {},
): Promise<{ id: string; name: string; email: string | null }> {
  if (opts.force) await keychainDelete(KEYCHAIN_ACCOUNT);

  let onCode!: (code: string) => void;
  let onError!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => ((onCode = res), (onError = rej)));

  const provider = new KeychainOAuthProvider(oauthRedirectUrl(cfg), oauthScope(cfg), (url) => {
    opts.onUrl?.(url);
    Bun.spawn(["open", url.href]);
  });

  const page = (msg: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>Linear autopilot</title><body style="font:16px -apple-system,sans-serif;padding:40px">${msg}</body>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.oauthCallbackPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error")) {
        onError(new Error(`authorization failed: ${url.searchParams.get("error")} ${url.searchParams.get("error_description") ?? ""}`));
        return page("Authorization failed. You can close this tab.");
      }
      if (url.searchParams.get("state") !== provider.state() || !code) {
        onError(new Error("authorization callback had a bad state or no code"));
        return page("Unexpected callback. You can close this tab.");
      }
      onCode(code);
      return page("Linear autopilot is signed in. You can close this tab.");
    },
  });

  try {
    const { transport, connect, client } = connectMcp(provider);
    try {
      await connect();
      await client.close();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const timeout = setTimeout(() => onError(new Error("timed out waiting for the browser (5 min)")), 300_000);
      try {
        await transport.finishAuth(await codePromise);
      } finally {
        clearTimeout(timeout);
      }
    }
    const linear = new LinearClient(provider);
    const me = await linear.viewer();
    await linear.close();
    return me;
  } finally {
    server.stop(true);
  }
}

/** Revokes the stored Linear tokens (best effort) and removes them from the Keychain. */
export async function signOut(cfg: Config): Promise<void> {
  const provider = new KeychainOAuthProvider(oauthRedirectUrl(cfg), oauthScope(cfg), () => {});
  const [tokens, client] = await Promise.all([provider.tokens(), provider.clientInformation()]);
  for (const [token, hint] of [
    [tokens?.refresh_token, "refresh_token"],
    [tokens?.access_token, "access_token"],
  ] as const) {
    if (!token) continue;
    await fetch("https://mcp.linear.app/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: hint, ...(client?.client_id ? { client_id: client.client_id } : {}) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {}); // the Keychain entry is removed either way
  }
  await keychainDelete(KEYCHAIN_ACCOUNT);
}

/** CLI: `linear-autopilot login [--force]`. */
export async function login(opts: { force?: boolean } = {}) {
  const cfg = loadConfig();
  try {
    const me = await browserLogin(cfg, {
      force: opts.force,
      onUrl: (url) => console.log(`Opening Linear in your browser to authorize linear-autopilot (scope: ${oauthScope(cfg)}).\nIf it doesn't open: ${url.href}`),
    });
    console.log(`Logged in to Linear as ${me.name}${me.email ? ` <${me.email}>` : ""}. Credentials are in the macOS Keychain (service "linear-autopilot").`);
  } catch (err) {
    console.error(`Login failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

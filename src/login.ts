import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, oauthRedirectUrl, oauthScope } from "./config";
import { keychainDelete } from "./keychain";
import { connectMcp, KeychainOAuthProvider, LinearClient } from "./linear";


/**
 * One-time browser login to Linear's MCP server. `force` discards stored credentials first
 * (needed after enabling moveToInProgressOnApprove, which needs the write scope).
 */
export async function login(opts: { force?: boolean } = {}) {
  const cfg = loadConfig();
  if (opts.force) await keychainDelete("linear-mcp-oauth");

  let onCode!: (code: string) => void;
  let onError!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => ((onCode = res), (onError = rej)));

  const provider = new KeychainOAuthProvider(oauthRedirectUrl(cfg), oauthScope(cfg), (url) => {
    console.log(`Opening Linear in your browser to authorize linear-autopilot (scope: ${oauthScope(cfg)}).\nIf it doesn't open: ${url.href}`);
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
        return page("Authorization failed. Check the terminal.");
      }
      if (url.searchParams.get("state") !== provider.state() || !code) {
        onError(new Error("authorization callback had a bad state or no code"));
        return page("Unexpected callback. Check the terminal.");
      }
      onCode(code);
      return page("Linear autopilot is authorized. You can close this tab.");
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
      await transport.finishAuth(await codePromise);
      clearTimeout(timeout);
    }
    const linear = new LinearClient(provider);
    const me = await linear.viewer();
    await linear.close();
    console.log(`Logged in to Linear as ${me.name} (${me.id}). Credentials are in the macOS Keychain (service "linear-autopilot").`);
  } catch (err) {
    console.error(`Login failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    server.stop(true);
  }
}

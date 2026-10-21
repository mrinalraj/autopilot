import { authPage } from "./views/auth";

interface OAuthCallbackOptions {
  port: number;
  label: string;
  state: () => string;
  onCode: (code: string) => void;
  onError: (error: Error) => void;
}

/** Loopback HTTP adapter; the login workflow owns credential exchange and server lifetime. */
export function startOAuthCallback(options: OAuthCallbackOptions) {
  const page = (message: string) => new Response(authPage(message), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error")) {
        options.onError(new Error(`authorization failed: ${url.searchParams.get("error")} ${url.searchParams.get("error_description") ?? ""}`));
        return page("Authorization failed. You can close this tab.");
      }
      if (url.searchParams.get("state") !== options.state() || !code) {
        options.onError(new Error("authorization callback had a bad state or no code"));
        return page("Unexpected callback. You can close this tab.");
      }
      options.onCode(code);
      return page(`Autopilot is signed in to ${options.label}. You can close this tab.`);
    },
  });
}

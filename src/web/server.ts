import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Autopilot } from "../app/autopilot";
import { CONFIG_PATH } from "../config/config";
import { githubStatus } from "../platform/github";
import { log } from "../shared/log";
import { redirect } from "./http";
import { handleAction } from "./routes/actions";
import { handlePage } from "./routes/pages";
import type { WebContext, WebOptions } from "./context";

/** HTTP composition and request security. Rendering and application actions live separately. */
export function startWeb(ap: Autopilot, extras: WebOptions = {}, listening?: ReturnType<typeof Bun.serve>) {
  const port = ap.cfg.port;
  const csrf = ap.store.getMeta("csrf_token") ?? randomBytes(24).toString("hex");
  ap.store.setMeta("csrf_token", csrf);
  const context: WebContext = {
    ...extras, ap, csrf, bootId: randomBytes(6).toString("hex"),
    configPath: extras.configPath ?? CONFIG_PATH, gh: extras.gh ?? githubStatus,
    ghAsync: extras.ghAsync ?? (extras.gh ? async () => extras.gh!() : undefined),
  };
  const allowedHosts = new Set(["localhost:" + port, "127.0.0.1:" + port]);
  const validToken = (token: unknown) => {
    if (typeof token !== "string") return false;
    const actual = Buffer.from(token), expected = Buffer.from(csrf);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const options = {
    hostname: "127.0.0.1", port,
    async fetch(req: Request) {
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
      const url = new URL(req.url);
      if (req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden origin", { status: 403 });
        const form = await req.formData();
        if (!validToken(form.get("csrf"))) {
          return redirect("/?error=" + encodeURIComponent("The page was out of date (the app had restarted), so nothing was done. Try again."));
        }
        return handleAction(url.pathname, form, context);
      }
      return handlePage(url, { ...context, desktopClient: /\bAutopilotDesktop\//.test(req.headers.get("user-agent") ?? "") });
    },
  };
  const server = listening ?? Bun.serve(options);
  if (listening) listening.reload(options);
  log.info("approval page at http://localhost:" + server.port);
  return server;
}

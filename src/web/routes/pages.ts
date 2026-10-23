import { homedir } from "node:os";
import { eventsSince } from "../../shared/log";
import { repoSources } from "../../repos/catalog";
import { suggestFolders } from "../../repos/suggestions";
import { desktopDataId } from "../../platform/desktop";
import { version as APP_VERSION } from "../../../package.json";
import { doneSteps, isStep, STEPS } from "../setup";
import { setupBody } from "../views/setup";
import { dashboardBody } from "../views/dashboard";
import { modalId } from "../views/components/ticket-shared";
import { csrfField } from "../views/forms";
import { dashboardData } from "../presenters/dashboard";
import { liveState } from "../state";
import { serveStatic } from "../static";
import { page, redirect } from "../http";
import type { WebContext } from "../context";
import { settingsData, settingsPage } from "../settings-data";

export async function handlePage(url: URL, ctx: WebContext): Promise<Response> {
  const { ap, gh } = ctx;
  const path = url.pathname;
  const error = url.searchParams.get("error") ?? undefined;
  const notice = url.searchParams.get("notice") ?? undefined;
  if (path === "/desktop-info") return Response.json({ app: "autopilot", protocol: 1, version: APP_VERSION,
    data: desktopDataId(ap.cfg), boot: ctx.bootId }, { headers: { "Cache-Control": "no-store" } });
  if (path === "/events") return Response.json(eventsSince(Number(url.searchParams.get("since") ?? 0)), { headers: { "Cache-Control": "no-store" } });
  if (path === "/state") return Response.json(liveState(ctx), { headers: { "Cache-Control": "no-store" } });
  const file = serveStatic(path, ap.cfg.port);
  if (file) return file;
  if (path === "/healthz") return Response.json({ ok: true, lastPollAt: ap.lastPollAt, lastPollError: ap.lastPollError, progress: ap.progress });
  if (path === "/settings/data") {
    try {
      const data = await settingsData(ctx, url.searchParams.get("part") ?? "", url.searchParams.get("refresh") === "1");
      return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (path === "/settings") return page("Settings · Autopilot", settingsPage(ctx, error, notice));
  if (path === "/" && !ap.cfg.onboarded) return redirect("/setup");
  if (path === "/") {
    const data = await dashboardData(ctx, error, notice);
    return page(data.queue.length ? "(" + data.queue.length + ") Autopilot" : "Autopilot", dashboardBody(data));
  }
  if (path === "/setup") {
    const ghNow = gh();
    const repos = repoSources(ap.cfg);
    const account = await ap.account().catch(() => null);
    const asked = url.searchParams.get("step");
    const done = doneSteps({ cfg: ap.cfg, repos, gh: ghNow, account });
    const step = isStep(asked) ? asked : STEPS.find((s) => !done.has(s.id))?.id ?? "start";
    return page("Set up · Autopilot", setupBody({
      cfg: ap.cfg, homeDir: homedir(), step, tokenField: csrfField(ctx.csrf), trackerLabel: ap.trackerLabel,
      account, signingIn: ap.signingIn, gh: ghNow, repos,
      suggestions: step === "repos" ? suggestFolders() : [],
      statuses: step === "statuses" && account ? await ap.statusOptions() : [], error, notice,
    }));
  }
  const match = path.match(/^\/issues\/([^/]+)$/);
  if (match) return redirect("/#" + modalId(decodeURIComponent(match[1])));
  return new Response("not found", { status: 404 });
}

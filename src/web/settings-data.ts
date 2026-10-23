import { HOME_DIR, LOG_PATH } from "../config/config";
import { listRepos } from "../repos/catalog";
import { githubStatusAsync } from "../platform/github";
import { isDesktop } from "../platform/desktop";
import type { WebContext } from "./context";
import { settingsBody } from "./views/settings";
import { version } from "../../package.json";

const cache = new WeakMap<object, Map<string, { until: number; value: Promise<unknown> }>>();

async function service(): Promise<string> {
  if (isDesktop()) return "Managed by Autopilot.app";
  const p = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const row = out.split("\n").find((s) => /\s(?:dev\.autopilot|(?:sh\.brew|homebrew\.mxcl)\.(?:linear-)?autopilot)$/.test(s));
  return row ? `Background service: ${row.trim().split(/\s+/).at(-1)}` : "Running outside a background service";
}

/** Each optional section loads independently; a slow tracker cannot hold up the settings page. */
export async function settingsData(ctx: WebContext, part: string, refresh = false): Promise<unknown> {
  const { ap } = ctx;
  const loaders: Record<string, () => Promise<unknown>> = {
    account: () => ap.account(),
    statuses: () => ap.statusOptions(),
    repos: async () => listRepos(ap.cfg),
    github: () => ctx.ghAsync ? ctx.ghAsync() : githubStatusAsync(),
    service,
  };
  const loader = loaders[part];
  if (!loader) throw new Error("Unknown settings section");
  let entries = cache.get(ap);
  if (!entries) { entries = new Map(); cache.set(ap, entries); }
  const key = JSON.stringify([part, ap.cfg.tracker, ap.cfg.stateDir, ap.cfg.jira.site, ap.cfg.githubUser, ap.cfg.repoRoots, ap.cfg.repoPaths, ap.cfg.repos]);
  const found = entries.get(key);
  if (!refresh && found && Date.now() < found.until) return found.value;
  let timer: ReturnType<typeof setTimeout>;
  const value = Promise.race([
    Promise.resolve().then(loader),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("This check took too long. You can retry; your settings are still available.")), 8000); }),
  ]).finally(() => clearTimeout(timer));
  entries.set(key, { until: Date.now() + 60_000, value });
  try { return await value; } catch (error) { entries.delete(key); throw error; }
}

export function settingsPage(ctx: WebContext, error?: string, notice?: string, draft?: FormData) {
  return settingsBody({
    cfg: ctx.ap.cfg, version, paths: { config: ctx.configPath, home: HOME_DIR, log: LOG_PATH },
    tracker: ctx.ap.trackerLabel, signingIn: ctx.ap.signingIn,
    tokenField: `<input type="hidden" name="csrf" value="${ctx.csrf}">`,
    dismissedTips: ctx.ap.store.dismissedBanners().size, error, notice, draft,
  });
}

export function invalidateSettings(ctx: WebContext) { cache.delete(ctx.ap); }

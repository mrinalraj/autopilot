import { mkdirSync } from "node:fs";
import { baseUrl, loadConfig, type Config } from "../config/config";
import { repoSources } from "../repos/catalog";
import { Store } from "../storage/db";
import { openTracker } from "../trackers/connect";
import { createLLM } from "../triage/llm";
import { Autopilot } from "./autopilot";
import { startWeb } from "../web/server";
import { prepareSecrets } from "../platform/env";
import { log } from "../shared/log";
import { Updater } from "../updates/updater";
import { Health } from "./health";

/** Runs the poller, work tracker and web page; with `once`, a single poll and exit. */
type DaemonOptions = { once?: boolean; onReady?: (url: string) => void };

export async function runDaemon(opts: DaemonOptions = {}) {
  const cfg = loadConfig();
  // Claim the port before opening SQLite (startup recovers interrupted launches).
  // A second app must not mutate the running daemon's ticket state.
  let server: ReturnType<typeof Bun.serve> | undefined;
  if (!opts.once) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: cfg.port,
        fetch: () => new Response("Autopilot is starting", { status: 503 }) });
      cfg.port = server.port!;
    } catch (err) {
      if ((err as { code?: string }).code === "EADDRINUSE") {
        throw new Error(`Port ${cfg.port} is already in use. Stop the existing Autopilot service (brew services stop autopilot, or autopilot service uninstall for a standalone install), then reopen the app.`);
      }
      throw err;
    }
  }
  try {
    await startDaemon(cfg, opts, server);
  } catch (err) {
    server?.stop(true);
    throw err;
  }
}

async function startDaemon(cfg: Config, opts: DaemonOptions, server?: ReturnType<typeof Bun.serve>) {
  mkdirSync(cfg.briefsDir, { recursive: true });
  await prepareSecrets(cfg);

  // The daemon never opens a browser; a missing or revoked login surfaces as a poll error.
  const { tracker } = openTracker(cfg);
  const ap = new Autopilot(cfg, new Store(cfg.stateDir), tracker, createLLM(cfg));

  if (opts.once) {
    await ap.poll();
    process.exit(ap.lastPollError ? 1 : 0);
  }

  // Timers read the live config, so Settings changes to the intervals apply without a restart.
  let timers: ReturnType<typeof setInterval>[] = [];
  function reschedule() {
    timers.forEach(clearInterval);
    timers = [
      setInterval(() => void ap.pollIfReady(), cfg.pollIntervalSeconds * 1000),
      setInterval(() => void ap.refreshWork(), cfg.workCheckIntervalSeconds * 1000),
      // Local setup must recover even while the tracker is signed out or unavailable.
      setInterval(() => ap.reconfigureLaunchers(), 30_000),
    ];
  }

  const updater = new Updater();
  const health = new Health(cfg);
  startWeb(ap, { updater, health, reschedule }, server);
  opts.onReady?.(`http://127.0.0.1:${server!.port}`);
  void health.refresh().catch((err) => log.warn("setup check failed", err));
  setInterval(() => void health.refresh().catch(() => {}), 10 * 60_000);
  log.info(`polling ${tracker.label} every ${cfg.pollIntervalSeconds}s; ${repoSources(cfg).length} repos; llm ${cfg.llm.provider}/${cfg.llm.model}`);
  reschedule();
  ap.reconfigureLaunchers();
  if (!cfg.onboarded) log.info(`first run: finish setup at ${baseUrl(cfg)}/setup; nothing is checked until then`);
  await ap.pollIfReady();
  void ap.refreshWork();
  updater.start();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`received ${sig}, exiting`);
      process.exit(0);
    });
  }
}

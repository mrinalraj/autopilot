import { mkdirSync } from "node:fs";
import { baseUrl, loadConfig } from "../config/config";
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
export async function runDaemon(opts: { once?: boolean } = {}) {
  const cfg = loadConfig();
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
    ];
  }

  const updater = new Updater();
  const health = new Health(cfg);
  await health.refresh().catch((err) => log.warn("setup check failed", err));
  setInterval(() => void health.refresh().catch(() => {}), 10 * 60_000);
  try {
    startWeb(ap, { updater, health, reschedule });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      log.error(`port ${cfg.port} is already in use; is another autopilot running? (try: autopilot service status)`);
      process.exit(1);
    }
    throw err;
  }
  log.info(`polling ${tracker.label} every ${cfg.pollIntervalSeconds}s; ${repoSources(cfg).length} repos; llm ${cfg.llm.provider}/${cfg.llm.model}`);
  reschedule();
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

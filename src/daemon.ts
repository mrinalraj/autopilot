import { mkdirSync } from "node:fs";
import { loadConfig, oauthRedirectUrl, oauthScope } from "./config";
import { Store } from "./db";
import { KeychainOAuthProvider, LinearClient, LoginRequiredError } from "./linear";
import { createLLM } from "./llm";
import { Autopilot } from "./autopilot";
import { startWeb } from "./web";
import { prepareSecrets } from "./env";
import { log } from "./log";
import { Updater } from "./updater";

/** Runs the poller, work tracker and web page; with `once`, a single poll and exit. */
export async function runDaemon(opts: { once?: boolean } = {}) {
  const cfg = loadConfig();
  mkdirSync(cfg.briefsDir, { recursive: true });
  await prepareSecrets(cfg);

  // The daemon never opens a browser; a missing or revoked login surfaces as a poll error.
  const provider = new KeychainOAuthProvider(oauthRedirectUrl(cfg), oauthScope(cfg), () => {
    throw new LoginRequiredError();
  });
  const ap = new Autopilot(cfg, new Store(cfg.stateDir), new LinearClient(provider), createLLM(cfg));

  if (opts.once) {
    await ap.poll();
    process.exit(ap.lastPollError ? 1 : 0);
  }

  const updater = new Updater();
  try {
    startWeb(ap, updater);
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      log.error(`port ${cfg.port} is already in use; is another linear-autopilot running? (try: linear-autopilot service status)`);
      process.exit(1);
    }
    throw err;
  }
  log.info(`polling Linear every ${cfg.pollIntervalSeconds}s; repos under ${cfg.reposRoot}; llm ${cfg.llm.provider}/${cfg.llm.model}`);
  await ap.poll();
  setInterval(() => void ap.poll(), cfg.pollIntervalSeconds * 1000);
  void ap.refreshWork();
  setInterval(() => void ap.refreshWork(), cfg.workCheckIntervalSeconds * 1000);
  updater.start();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`received ${sig}, exiting`);
      process.exit(0);
    });
  }
}

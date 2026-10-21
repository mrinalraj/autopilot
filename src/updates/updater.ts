import { applyUpdate, checkForUpdate, type UpdateInfo } from "./update";
import { log } from "../shared/log";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Holds the latest update check for the page, re-checks daily, and runs installs on request. */
export class Updater {
  info: UpdateInfo | null = null;
  status: "idle" | "updating" | "restarting" | "error" = "idle";
  error: string | null = null;

  start() {
    // Let startup settle before the first check; GitHub is not on the critical path.
    setTimeout(() => void this.check(), 30_000);
    setInterval(() => void this.check(), DAY_MS);
  }

  async check(): Promise<UpdateInfo | null> {
    try {
      this.info = await checkForUpdate();
      if (this.info?.available) log.info(`update available: ${this.info.current} → ${this.info.latest}`);
    } catch (err) {
      log.warn("update check failed", err);
    }
    return this.info;
  }

  /** Installs in the background; under launchd the process exits so the new version starts. */
  install(): { ok: true } | { ok: false; error: string } {
    if (!this.info?.available) return { ok: false, error: "no update available" };
    if (this.status === "updating" || this.status === "restarting") return { ok: false, error: "an update is already running" };
    this.status = "updating";
    this.error = null;
    void applyUpdate(this.info)
      .then(({ restartsAutomatically }) => {
        if (restartsAutomatically) {
          this.status = "restarting";
          setTimeout(() => process.exit(0), 500);
        } else {
          this.status = "error";
          this.error = `Installed ${this.info!.latest}; restart autopilot to use it.`;
        }
      })
      .catch((err) => {
        this.status = "error";
        this.error = (err as Error).message;
        log.error("update failed", err);
      });
    return { ok: true };
  }
}

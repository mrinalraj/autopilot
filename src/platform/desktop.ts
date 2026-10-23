import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/config";

/** The native host owns stdin/stdout; no browser-to-native command bridge is exposed. */
export const isDesktop = () => process.env.AUTOPILOT_DESKTOP === "1";

export type DesktopEvent =
  | { type: "ready"; url: string; ownership?: "owned" | "external" }
  | { type: "disconnected"; message: string }
  | { type: "restarting" }
  | { type: "notification"; title: string; message: string; openUrl: string; group: string };

export function desktopEvent(event: DesktopEvent) {
  if (isDesktop()) console.log(`AUTOPILOT_DESKTOP:${JSON.stringify(event)}`);
}

/** Compare the data store without exposing its filesystem path over HTTP. */
export function desktopDataId(cfg: Pick<Config, "stateDir" | "tracker">): string {
  let path = resolve(cfg.stateDir);
  try { path = realpathSync(path); } catch { /* A fresh install may not have a store yet. */ }
  return createHash("sha256").update(JSON.stringify([path, cfg.tracker])).digest("hex");
}

/** EOF also stops the helper if the native app crashes or is force-quit. */
export function watchDesktopHost() {
  if (!isDesktop() || process.stdin.isTTY) throw new Error("the desktop helper must be launched by Autopilot.app");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

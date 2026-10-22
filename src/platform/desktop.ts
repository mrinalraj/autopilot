/** The native host owns stdin/stdout; no browser-to-native command bridge is exposed. */
export const isDesktop = () => process.env.AUTOPILOT_DESKTOP === "1";

export type DesktopEvent =
  | { type: "ready"; url: string }
  | { type: "restarting" }
  | { type: "notification"; title: string; message: string; openUrl: string; group: string };

export function desktopEvent(event: DesktopEvent) {
  if (isDesktop()) console.log(`AUTOPILOT_DESKTOP:${JSON.stringify(event)}`);
}

/** EOF also stops the helper if the native app crashes or is force-quit. */
export function watchDesktopHost() {
  if (!isDesktop() || process.stdin.isTTY) throw new Error("the desktop helper must be launched by Autopilot.app");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

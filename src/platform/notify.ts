import { log } from "../shared/log";

let notifierPath: string | null | undefined;

function findNotifier(): string | null {
  if (notifierPath === undefined) {
    notifierPath =
      Bun.which("terminal-notifier", { PATH: process.env.PATH }) ??
      ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find((p) => Bun.file(p).size > 0) ??
      null;
    if (!notifierPath) log.warn("terminal-notifier not found; falling back to osascript (no click-to-open)");
  }
  return notifierPath;
}

// terminal-notifier treats a leading "-" or "[" specially; keep untrusted text plain.
const plain = (s: string, max: number) => s.replace(/\s+/g, " ").trim().replace(/^[-[]+/, "").slice(0, max);

let hinted = false;

/** Whether macOS refused terminal-notifier's last notification (surfaced as a setup banner). */
export const notifyState = { permissionDenied: false };

async function run(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", env: process.env });
    const err = await new Response(proc.stderr).text();
    return (await proc.exited) === 0 ? null : err.trim() || "failed";
  } catch (err) {
    return (err as Error).message;
  }
}

export async function notify(opts: { title: string; message: string; openUrl: string; group: string }) {
  if (process.env.AUTOPILOT_NOTIFY === "off") return;
  const title = plain(opts.title, 120);
  const message = plain(opts.message, 300) || "New ticket";
  const notifier = findNotifier();
  if (notifier) {
    const err = await run([notifier, "-title", title, "-message", message, "-open", opts.openUrl, "-group", opts.group]);
    notifyState.permissionDenied = !!err && /not allowed|permission/i.test(err);
    if (!err) return;
    if (!hinted) {
      hinted = true;
      log.warn(
        `terminal-notifier failed (${err}). Allow it in System Settings → Notifications → terminal-notifier; ` +
          "falling back to osascript, which can't open the page on click",
      );
    }
  }
  // Pass text as argv so it is never interpreted as AppleScript.
  const err = await run(["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, message]);
  if (err) log.warn("notification failed", err);
}

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COMPILED, HOME_DIR, LOG_PATH } from "./config";

/** LaunchAgent that runs `linear-autopilot start` at login and restarts it if it exits. */
export const LABEL = "dev.linear-autopilot";
/** Labels `brew services` uses (newer Homebrew: sh.brew.*, older: homebrew.mxcl.*). */
const BREW_LABELS = ["sh.brew.linear-autopilot", "homebrew.mxcl.linear-autopilot"];

const plistPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${process.getuid!()}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The command launchd runs. Homebrew's versioned Cellar path is swapped for the stable opt path. */
function programArguments(): string[] {
  if (!COMPILED) return [process.execPath, join(HOME_DIR, "src", "cli.ts"), "start"];
  const m = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/);
  return [m ? `${m[1]}/opt/${m[2]}/bin/${m[3]}` : process.execPath, "start"];
}

function launchctl(...args: string[]) {
  const p = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: `${p.stdout}${p.stderr}`.trim() };
}

export function installService() {
  if (COMPILED && process.execPath.includes("/Cellar/")) {
    throw new Error("installed with Homebrew: use `brew services start linear-autopilot` instead");
  }
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const args = programArguments().map((a) => `<string>${xml(a)}</string>`).join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key><string>${xml(HOME_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath(LABEL)), { recursive: true });
  launchctl("bootout", `${domain()}/${LABEL}`);
  writeFileSync(plistPath(LABEL), plist);
  const r = launchctl("bootstrap", domain(), plistPath(LABEL));
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  console.log(`Installed ${plistPath(LABEL)}; it starts at login and restarts if it exits.\nLogs: ${LOG_PATH}`);
}

export function uninstallService() {
  launchctl("bootout", `${domain()}/${LABEL}`);
  rmSync(plistPath(LABEL), { force: true });
  console.log(`Removed ${LABEL}.`);
}

/** The label of whichever service is loaded: ours or Homebrew's. */
function loadedLabel(): string | null {
  return [LABEL, ...BREW_LABELS].find((l) => launchctl("print", `${domain()}/${l}`).code === 0) ?? null;
}

export function restartService() {
  const r = launchctl("kickstart", "-k", `${domain()}/${loadedLabel() ?? LABEL}`);
  if (r.code !== 0) throw new Error(`not installed or not loaded (${r.out}); run: linear-autopilot service install`);
  console.log("Restarted.");
}

export function serviceStatus(): string {
  const label = loadedLabel();
  if (!label) return "not running as a service";
  const r = launchctl("print", `${domain()}/${label}`);
  const field = (k: string) => r.out.match(new RegExp(`^\\s*${k} = (.*)$`, "m"))?.[1] ?? "?";
  return `${label}: ${field("state")}, pid ${field("pid")}, last exit ${field("last exit code")}`;
}

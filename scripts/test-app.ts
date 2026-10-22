import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Requires a desktop session. All backend services are fake; only our own processes are killed.
process.chdir(resolve(import.meta.dir, ".."));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const builtApp = resolve(`dist/desktop-${arch}/Autopilot.app`);
if (!existsSync(builtApp)) throw new Error("Run bun run build:app first.");
const root = mkdtempSync(join(tmpdir(), "autopilot-native-smoke-"));
const home = join(root, "data"); mkdirSync(home);
const app = join(root, "Autopilot Smoke.app");
cpSync(builtApp, app, { recursive: true });
function run(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`${args[0]} failed: ${result.stderr}`);
}
run(["/usr/libexec/PlistBuddy", "-c", "Set :CFBundleIdentifier dev.autopilot.smoke", `${app}/Contents/Info.plist`]);
const helper = `${app}/Contents/Helpers/autopilot`;
run([process.execPath, "build", resolve("test/fixtures/desktop-helper.ts"), "--compile", "--outfile", helper]);
run(["/usr/bin/codesign", "--force", "--sign", "-", "--entitlements", resolve("desktop/macos/helper-entitlements.plist"), helper]);
run(["/usr/bin/codesign", "--force", "--sign", "-", app]);
const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = free.port; free.stop(true);
writeFileSync(join(home, "config.json"), JSON.stringify({ port, onboarded: true, repoRoots: [], repoPaths: [], launch: { launcher: "git", terminal: "none" } }));
const child = Bun.spawn([`${app}/Contents/MacOS/Autopilot`], {
  env: { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_CONFIG: `${home}/config.json`, AUTOPILOT_NOTIFY: "off" },
  stdout: "ignore", stderr: Bun.file(join(root, "host.log")),
});
let helperPID = 0, passed = false;
async function waitFor(check: () => boolean, label: string) {
  for (let n = 0; n < 150; n++) { if (check()) return; await Bun.sleep(200); }
  throw new Error(`Timed out: ${label}; logs in ${root}`);
}
const requests = () => existsSync(`${home}/requests.jsonl`) ? readFileSync(`${home}/requests.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
try {
  await waitFor(() => existsSync(`${home}/helper.pid`), "worker launch");
  helperPID = Number(readFileSync(`${home}/helper.pid`, "utf8"));
  await waitFor(() => requests().some(req => req.path === "/" && req.agent?.includes("AppleWebKit")), "WebKit interface request");
  await waitFor(() => requests().some(req => req.path === "/state" && req.agent?.includes("AppleWebKit")), "WebKit live script");
  console.log("PASS: native host launched its child; WKWebView loaded the real dashboard and executed live polling.");
  process.kill(helperPID, "SIGKILL");
  await waitFor(() => Number(readFileSync(`${home}/helper.pid`, "utf8")) !== helperPID, "worker recovery");
  helperPID = Number(readFileSync(`${home}/helper.pid`, "utf8"));
  console.log("PASS: the host restarted a crashed worker.");
  child.kill("SIGKILL");
  await child.exited;
  await waitFor(() => { try { process.kill(helperPID, 0); return false; } catch { return true; } }, "worker cleanup after host death");
  console.log("PASS: the worker exited when the host died.");
  passed = true;
} finally {
  child.kill("SIGKILL");
  if (helperPID) { try { process.kill(helperPID, "SIGTERM"); } catch {} }
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Test artifacts retained at ${root}`);
}

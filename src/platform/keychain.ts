/**
 * macOS login Keychain storage (generic passwords under service "autopilot").
 * Values go to `security` over stdin as hex, so they never appear in argv or on disk.
 */

import { COMPILED } from "../config/config";

const SERVICE = "autopilot";
/** The service name from when the app was called linear-autopilot; entries move over on first read. */
const LEGACY_SERVICE = "linear-autopilot";

/** Tracker sign-ins from source get their own entry, so dev never signs the installed app in or out. */
export const oauthAccount = (account: string) => (COMPILED ? account : `${account}-dev`);

async function read(service: string, account: string): Promise<string | null> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", account, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.replace(/\n$/, "") : null;
}

export async function keychainGet(account: string): Promise<string | null> {
  const value = await read(SERVICE, account);
  if (value !== null) return value;
  const legacy = await read(LEGACY_SERVICE, account);
  if (legacy === null) return null;
  await keychainSet(account, legacy);
  await Bun.spawn(["security", "delete-generic-password", "-s", LEGACY_SERVICE, "-a", account], { stdout: "ignore", stderr: "ignore" }).exited;
  return legacy;
}

export async function keychainSet(account: string, value: string): Promise<void> {
  const hex = Buffer.from(value, "utf8").toString("hex");
  const proc = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  proc.stdin.write(`add-generic-password -U -s ${SERVICE} -a ${account} -X ${hex}\n`);
  await proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`keychain write failed: ${(await new Response(proc.stderr).text()).trim()}`);
}

export async function keychainDelete(account: string): Promise<void> {
  await Bun.spawn(["security", "delete-generic-password", "-s", SERVICE, "-a", account], { stdout: "ignore", stderr: "ignore" }).exited;
}

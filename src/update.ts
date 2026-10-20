import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdtempSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repository, version as CURRENT } from "../package.json";
import { COMPILED } from "./config";
import { log } from "./log";

/**
 * "Update available" checks against GitHub Releases, and in-place updates. Checks are automatic;
 * installs only happen when asked. Release assets follow scripts/build.sh:
 * linear-autopilot-<version>-darwin-<arch>.tar.gz plus checksums.txt (SHA-256).
 */

// Read at call time so tests (and overrides) can point at another server.
const api = () => process.env.AUTOPILOT_UPDATE_API ?? "https://api.github.com";
const repo = () => process.env.AUTOPILOT_UPDATE_REPO ?? repository;

export type InstallKind = "homebrew" | "standalone" | "source";

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes: string;
  checkedAt: string;
  kind: InstallKind;
  /** Download URLs for this machine's tarball and the release checksums. */
  assetUrl: string | null;
  checksumsUrl: string | null;
}

export const installKind = (execPath = process.execPath): InstallKind =>
  !COMPILED ? "source" : execPath.includes("/Cellar/") ? "homebrew" : "standalone";

/** Numeric x.y.z comparison; pre-release suffixes are ignored. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export const assetName = (ver: string, arch = process.arch === "arm64" ? "arm64" : "x64") =>
  `linear-autopilot-${ver}-darwin-${arch}.tar.gz`;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const res = await fetch(`${api()}/repos/${repo()}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `linear-autopilot/${CURRENT}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null; // no releases yet (or the repo isn't public)
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; html_url: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
  const latest = rel.tag_name.replace(/^v/, "");
  const asset = (name: string) => rel.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
  return {
    current: CURRENT,
    latest,
    available: newer(latest, CURRENT),
    url: rel.html_url,
    notes: (rel.body ?? "").slice(0, 2000),
    checkedAt: new Date().toISOString(),
    kind: installKind(),
    assetUrl: asset(assetName(latest)),
    checksumsUrl: asset("checksums.txt"),
  };
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": `linear-autopilot/${CURRENT}` }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Replaces the running binary with the release's: download, check the SHA-256 against
 * checksums.txt, extract, confirm the new binary reports the expected version, then rename it
 * over the old one (atomic on the same volume). The caller restarts the process.
 */
export async function installStandalone(info: UpdateInfo, target = process.execPath): Promise<void> {
  if (!info.assetUrl || !info.checksumsUrl) throw new Error(`release ${info.latest} has no ${assetName(info.latest)} or checksums.txt`);
  accessSync(dirname(target), constants.W_OK);

  const [tarball, sums] = await Promise.all([download(info.assetUrl), download(info.checksumsUrl)]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === assetName(info.latest))?.[0];
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${assetName(info.latest)}`);

  const work = mkdtempSync(join(tmpdir(), "linear-autopilot-update-"));
  try {
    await Bun.write(join(work, "update.tar.gz"), tarball);
    const tar = Bun.spawnSync(["tar", "-xzf", "update.tar.gz"], { cwd: work, stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`could not extract update: ${tar.stderr}`);
    const fresh = join(work, "linear-autopilot");
    chmodSync(fresh, 0o755);
    const reported = Bun.spawnSync([fresh, "version"], { stdout: "pipe" }).stdout.toString().trim();
    if (reported !== info.latest) throw new Error(`downloaded binary reports version "${reported}", expected ${info.latest}`);

    const staged = `${target}.new`;
    copyFileSync(fresh, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function installHomebrew(): void {
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => Bun.file(p).size > 0) ?? "brew";
  const r = Bun.spawnSync([brew, "upgrade", "linear-autopilot"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "" } });
  if (r.exitCode !== 0) throw new Error(`brew upgrade failed: ${`${r.stderr}`.trim().slice(-500)}`);
}

/** True when launchd (our service or `brew services`) will restart us after we exit. */
export const managedByLaunchd = () => !!process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0";

/** Installs `info` for this install kind. Returns whether a restart will pick it up automatically. */
export async function applyUpdate(info: UpdateInfo): Promise<{ restartsAutomatically: boolean }> {
  if (info.kind === "source") throw new Error("running from source: update with git pull instead");
  log.info(`updating ${info.current} → ${info.latest} (${info.kind})`);
  if (info.kind === "homebrew") installHomebrew();
  else await installStandalone(info);
  log.info(`installed ${info.latest}`);
  return { restartsAutomatically: managedByLaunchd() };
}

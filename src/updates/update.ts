import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdtempSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repository, version as CURRENT } from "../../package.json";
import { COMPILED } from "../config/config";
import { log } from "../shared/log";

/**
 * "Update available" checks against GitHub Releases, and in-place updates. Checks are automatic;
 * installs only happen when asked. Release assets follow scripts/build.sh:
 * autopilot-<version>-darwin-<arch>.tar.gz plus checksums.txt (SHA-256).
 */

// Read at call time so tests (and overrides) can point at another server.
const api = () => process.env.AUTOPILOT_UPDATE_API ?? "https://api.github.com";
const repo = () => process.env.AUTOPILOT_UPDATE_REPO ?? repository;

export type InstallKind = "desktop" | "homebrew" | "standalone" | "source";

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

export const installKind = (execPath = process.execPath, compiled = COMPILED): InstallKind =>
  !compiled ? "source" : /\.app\/Contents\/Helpers\/autopilot$/.test(execPath) ? "desktop"
    : execPath.includes("/Cellar/") ? "homebrew" : "standalone";

/**
 * Semver-style comparison: x.y.z numerically, then a release beats its pre-releases
 * (0.1.0 > 0.1.0-beta.2 > 0.1.0-beta.1).
 */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").slice(0, 3).map((n) => Number(n) || 0), pre };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // a release is newer than any of its pre-releases
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}

export const assetName = (ver: string, arch = process.arch === "arm64" ? "arm64" : "x64") =>
  `autopilot-${ver}-darwin-${arch}.tar.gz`;

interface Release {
  tag_name: string;
  html_url: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
}

/**
 * The newest release this install should move to. GitHub's /releases/latest skips pre-releases,
 * so a beta install picks from the list instead: betas follow betas and releases; a release
 * install only follows releases.
 */
export function pickRelease(releases: Release[], current = CURRENT): Release | null {
  const betas = current.includes("-");
  let best: Release | null = null;
  for (const r of releases) {
    if (r.draft || (r.prerelease && !betas)) continue;
    if (!best || newer(r.tag_name, best.tag_name)) best = r;
  }
  return best;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const res = await fetch(`${api()}/repos/${repo()}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `autopilot/${CURRENT}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null; // the repo isn't reachable (renamed, or not public)
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const rel = pickRelease((await res.json()) as Release[]);
  if (!rel) return null; // no releases yet
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
  const res = await fetch(url, { headers: { "User-Agent": `autopilot/${CURRENT}` }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Replaces the running binary with the release's: download, check the SHA-256 against
 * checksums.txt, extract, confirm the new binary reports the expected version, then rename it
 * over the old one (atomic on the same volume). The caller restarts the process.
 */
export async function installStandalone(info: UpdateInfo, target = process.execPath): Promise<void> {
  if (installKind(target, true) === "desktop") throw new Error("Update the whole app with brew upgrade --cask autopilot; bundled executables cannot be replaced separately.");
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

  const work = mkdtempSync(join(tmpdir(), "autopilot-update-"));
  try {
    await Bun.write(join(work, "update.tar.gz"), tarball);
    const tar = Bun.spawnSync(["tar", "-xzf", "update.tar.gz"], { cwd: work, stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`could not extract update: ${tar.stderr}`);
    const fresh = join(work, "autopilot");
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
  // Homebrew refreshes taps at most daily on its own; force it, or a just-published release looks absent.
  const r = Bun.spawnSync([brew, "upgrade", "autopilot"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "", HOMEBREW_AUTO_UPDATE_SECS: "0" },
  });
  if (r.exitCode !== 0) throw new Error(`brew upgrade failed: ${`${r.stderr}`.trim().slice(-500)}`);
}

/** True when launchd (our service or `brew services`) will restart us after we exit. */
export const managedByLaunchd = () => !!process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0";

/** Installs `info` for this install kind. Returns whether a restart will pick it up automatically. */
export async function applyUpdate(info: UpdateInfo): Promise<{ restartsAutomatically: boolean }> {
  if (info.kind === "desktop" || installKind() === "desktop") throw new Error("Quit Autopilot, run brew upgrade --cask autopilot, then reopen it. For a manual install, replace Autopilot.app with the new release.");
  if (info.kind === "source") throw new Error("running from source: update with git pull instead");
  log.info(`updating ${info.current} → ${info.latest} (${info.kind})`);
  if (info.kind === "homebrew") installHomebrew();
  else await installStandalone(info);
  log.info(`installed ${info.latest}`);
  return { restartsAutomatically: managedByLaunchd() };
}

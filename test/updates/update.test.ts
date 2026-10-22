import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "autopilot-update-"));
const port = 48000 + Math.floor(Math.random() * 900);
let server: ReturnType<typeof Bun.serve>;
let tarball: Uint8Array;
let sums = "";
let u: typeof import("../../src/updates/update");

beforeAll(async () => {
  // A fake new beta: a "binary" that reports 9.9.9-beta.2.
  const pkg = join(dir, "pkg");
  Bun.spawnSync(["mkdir", "-p", pkg]);
  writeFileSync(join(pkg, "autopilot"), "#!/bin/sh\necho 9.9.9-beta.2\n");
  chmodSync(join(pkg, "autopilot"), 0o755);
  Bun.spawnSync(["tar", "-C", pkg, "-czf", join(dir, "rel.tar.gz"), "autopilot"]);
  tarball = new Uint8Array(readFileSync(join(dir, "rel.tar.gz")));

  process.env.AUTOPILOT_UPDATE_API = `http://localhost:${port}`;
  process.env.AUTOPILOT_UPDATE_REPO = "me/app";
  u = await import("../../src/updates/update");
  const name = u.assetName("9.9.9-beta.2");
  sums = `${createHash("sha256").update(tarball).digest("hex")}  ${name}\n`;

  server = Bun.serve({
    port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      // Like GitHub: /releases/latest skips pre-releases, so with only betas it's a 404.
      if (path === "/repos/me/app/releases/latest") return new Response("not found", { status: 404 });
      if (path === "/repos/me/app/releases") {
        return Response.json([
          { tag_name: "v9.9.10-beta.1", draft: true, prerelease: true, html_url: "x", assets: [] },
          {
            tag_name: "v9.9.9-beta.2",
            prerelease: true,
            html_url: "https://example.test/rel",
            body: "notes",
            assets: [
              { name, browser_download_url: `http://localhost:${port}/dl/${name}` },
              { name: "checksums.txt", browser_download_url: `http://localhost:${port}/dl/checksums.txt` },
            ],
          },
          { tag_name: "v9.9.9-beta.1", prerelease: true, html_url: "x", assets: [] },
        ]);
      }
      if (path === `/dl/${name}`) return new Response(Bun.file(join(dir, "rel.tar.gz")));
      if (path === "/dl/checksums.txt") return new Response(sums);
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("version comparison", () => {
  expect(u.newer("0.2.0", "0.1.9")).toBe(true);
  expect(u.newer("v1.0.0", "0.9.9")).toBe(true);
  expect(u.newer("0.1.0", "0.1.0")).toBe(false);
  expect(u.newer("0.1.0", "0.10.0")).toBe(false);
  expect(u.newer("0.1.0", "0.1.0-beta.1")).toBe(true);
  expect(u.newer("0.1.0-beta.2", "0.1.0-beta.1")).toBe(true);
  expect(u.newer("0.1.0-beta.10", "0.1.0-beta.9")).toBe(true);
  expect(u.newer("0.1.0-beta.1", "0.1.0")).toBe(false);
  expect(u.newer("v0.1.0-beta.1", "0.1.0-beta.1")).toBe(false);
});

test("app bundles are distinct from standalone and formula installs", () => {
  expect(u.installKind("/Applications/Autopilot.app/Contents/Helpers/autopilot", true)).toBe("desktop");
  expect(u.installKind("/Users/me/Applications/Autopilot.app/Contents/Helpers/autopilot", true)).toBe("desktop");
  expect(u.installKind("/opt/homebrew/Cellar/autopilot/1/bin/autopilot", true)).toBe("homebrew");
  expect(u.installKind("/usr/local/bin/autopilot", true)).toBe("standalone");
  expect(u.installKind("/usr/local/bin/bun", false)).toBe("source");
});

test("updating a desktop install cannot replace its signed helper", async () => {
  const info = { ...(await u.checkForUpdate())!, kind: "desktop" as const };
  await expect(u.applyUpdate(info)).rejects.toThrow("brew upgrade --cask autopilot");
  await expect(u.installStandalone(info, "/Applications/Autopilot.app/Contents/Helpers/autopilot")).rejects.toThrow("bundled executables cannot be replaced");
});

test("finds the newer release and this machine's asset", async () => {
  const info = (await u.checkForUpdate())!;
  expect(info.available).toBe(true);
  expect(info.latest).toBe("9.9.9-beta.2"); // the newest non-draft beta, though /releases/latest is a 404
  expect(info.assetUrl).toContain(u.assetName("9.9.9-beta.2"));
  expect(info.kind).toBe("source"); // tests run from source
});

test("standalone install verifies the checksum and swaps the binary in place", async () => {
  const target = join(dir, "installed-autopilot");
  writeFileSync(target, "#!/bin/sh\necho 0.1.0\n");
  chmodSync(target, 0o755);
  const info = (await u.checkForUpdate())!;

  await u.installStandalone(info, target);
  expect(Bun.spawnSync([target, "version"]).stdout.toString().trim()).toBe("9.9.9-beta.2");

  // A tampered download is refused and the installed binary is left alone.
  writeFileSync(target, "#!/bin/sh\necho 0.1.0\n");
  sums = `${"0".repeat(64)}  ${u.assetName("9.9.9-beta.2")}\n`;
  await expect(u.installStandalone(info, target)).rejects.toThrow("checksum mismatch");
  expect(Bun.spawnSync([target, "version"]).stdout.toString().trim()).toBe("0.1.0");
});

test("betas follow betas; a release install only follows releases", () => {
  const rel = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: tag, ...extra });
  const list = [rel("v0.2.0-beta.1", { prerelease: true }), rel("v0.1.0"), rel("v0.3.0", { draft: true }), rel("v0.1.0-beta.9", { prerelease: true })];
  expect(u.pickRelease(list, "0.1.0-beta.7")?.tag_name).toBe("v0.2.0-beta.1");
  expect(u.pickRelease(list, "0.1.0")?.tag_name).toBe("v0.1.0");
  expect(u.pickRelease([], "0.1.0-beta.7")).toBeNull();
});

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
let u: typeof import("../src/update");

beforeAll(async () => {
  // A fake new release: a "binary" that reports 9.9.9.
  const pkg = join(dir, "pkg");
  Bun.spawnSync(["mkdir", "-p", pkg]);
  writeFileSync(join(pkg, "autopilot"), "#!/bin/sh\necho 9.9.9\n");
  chmodSync(join(pkg, "autopilot"), 0o755);
  Bun.spawnSync(["tar", "-C", pkg, "-czf", join(dir, "rel.tar.gz"), "autopilot"]);
  tarball = new Uint8Array(readFileSync(join(dir, "rel.tar.gz")));

  process.env.AUTOPILOT_UPDATE_API = `http://localhost:${port}`;
  process.env.AUTOPILOT_UPDATE_REPO = "me/app";
  u = await import("../src/update");
  const name = u.assetName("9.9.9");
  sums = `${createHash("sha256").update(tarball).digest("hex")}  ${name}\n`;

  server = Bun.serve({
    port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/repos/me/app/releases/latest") {
        return Response.json({
          tag_name: "v9.9.9",
          html_url: "https://example.test/rel",
          body: "notes",
          assets: [
            { name, browser_download_url: `http://localhost:${port}/dl/${name}` },
            { name: "checksums.txt", browser_download_url: `http://localhost:${port}/dl/checksums.txt` },
          ],
        });
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

test("finds the newer release and this machine's asset", async () => {
  const info = (await u.checkForUpdate())!;
  expect(info.available).toBe(true);
  expect(info.latest).toBe("9.9.9");
  expect(info.assetUrl).toContain(u.assetName("9.9.9"));
  expect(info.kind).toBe("source"); // tests run from source
});

test("standalone install verifies the checksum and swaps the binary in place", async () => {
  const target = join(dir, "installed-autopilot");
  writeFileSync(target, "#!/bin/sh\necho 0.1.0\n");
  chmodSync(target, 0o755);
  const info = (await u.checkForUpdate())!;

  await u.installStandalone(info, target);
  expect(Bun.spawnSync([target, "version"]).stdout.toString().trim()).toBe("9.9.9");

  // A tampered download is refused and the installed binary is left alone.
  writeFileSync(target, "#!/bin/sh\necho 0.1.0\n");
  sums = `${"0".repeat(64)}  ${u.assetName("9.9.9")}\n`;
  await expect(u.installStandalone(info, target)).rejects.toThrow("checksum mismatch");
  expect(Bun.spawnSync([target, "version"]).stdout.toString().trim()).toBe("0.1.0");
});

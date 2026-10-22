import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateBanner } from "../../src/web/views/components/banners";

test.each(["start", "desktop"])("a competing %s daemon is refused before creating or recovering ticket state", async (command) => {
  const home = mkdtempSync(join(tmpdir(), "autopilot-port-conflict-"));
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("another app") });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ port: listener.port, onboarded: false }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), command], {
    env: { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_CONFIG: config, AUTOPILOT_NOTIFY: "off", AUTOPILOT_DESKTOP: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(error).toContain("already in use");
    expect(error).toContain("brew services stop autopilot");
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${listener.port}`)).text()).toBe("another app");
  } finally {
    child.kill(); listener.stop(true); rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop helper exits when the host closes its pipe", async () => {
  const module = resolve(import.meta.dir, "../../src/platform/desktop.ts");
  const child = Bun.spawn([process.execPath, "-e", `import { watchDesktopHost } from ${JSON.stringify(module)}; watchDesktopHost(); console.log("ready"); setInterval(() => {}, 1000);`], {
    env: { ...process.env, AUTOPILOT_DESKTOP: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    reader.releaseLock();
    await child.stdin.end();
    expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "timeout")])).toBe(0);
  } finally { child.kill(); }
});

test("desktop update banners offer a whole-app upgrade instead of the binary installer", () => {
  const html = updateBanner({ status: "idle", error: null, info: {
    current: "0.1.0", latest: "0.2.0", available: true, url: "https://example.test/release", notes: "",
    checkedAt: "", kind: "desktop", assetUrl: null, checksumsUrl: null,
  } }, '<input name="csrf">');
  expect(html).toContain("brew upgrade --cask autopilot");
  expect(html).not.toContain('action="/update"');
});

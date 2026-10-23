import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateBanner } from "../../src/web/views/components/banners";
import { desktopDataId } from "../../src/platform/desktop";

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
    expect(error).toContain(command === "desktop" ? "brew upgrade --formula autopilot" : "brew services stop autopilot");
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${listener.port}`)).text()).toBe("another app");
  } finally {
    child.kill(); listener.stop(true); rmSync(home, { recursive: true, force: true });
  }
});

test("the app attaches without opening state, reconnects, and leaves an existing service running on exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "autopilot-attach-"));
  let data = desktopDataId({ stateDir: join(home, "state"), tracker: "linear" });
  let boot = "first", available = true, probes = 0;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    probes++;
    expect(new URL(req.url).pathname).toBe("/desktop-info");
    return available ? Response.json({ app: "autopilot", protocol: 1, data, boot }) : new Response("restarting", { status: 503 });
  } });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ port: listener.port, onboarded: false }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "desktop"], {
    env: { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_CONFIG: config, AUTOPILOT_NOTIFY: "off", AUTOPILOT_DESKTOP: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const drain = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk); })();
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 60; i++) { if (check()) return; await Bun.sleep(100); }
    throw new Error(`Timed out: ${output}`);
  }
  try {
    await waitFor(() => output.includes('"ownership":"external"'));
    expect(existsSync(join(home, "state"))).toBe(false);
    available = false;
    await waitFor(() => output.includes('"type":"disconnected"'));
    expect(child.exitCode).toBe(null);
    expect(existsSync(join(home, "state"))).toBe(false);
    boot = "second"; available = true;
    await waitFor(() => output.split('"type":"ready"').length === 3);
    // The service switches store after the user's tracker selection; no app restart is needed.
    writeFileSync(config, JSON.stringify({ port: listener.port, onboarded: false, tracker: "jira" }));
    data = desktopDataId({ stateDir: join(home, "state", "jira"), tracker: "jira" });
    const before = probes;
    await waitFor(() => probes >= before + 2);
    expect(output.split('"type":"disconnected"')).toHaveLength(2);
    await child.stdin.end();
    expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "timeout")])).toBe(0);
    await drain;
    expect((await (await fetch(`http://127.0.0.1:${listener.port}/desktop-info`)).json()).boot).toBe("second");
    expect(existsSync(join(home, "state"))).toBe(false);
  } finally { child.kill(); listener.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 15000);

test.each(["other-store", "unsupported-protocol"])("the app refuses %s without touching the existing service", async (mismatch) => {
  const home = mkdtempSync(join(tmpdir(), "autopilot-attach-mismatch-"));
  const data = desktopDataId({ stateDir: join(home, "state"), tracker: "linear" });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
    app: "autopilot", protocol: mismatch === "unsupported-protocol" ? 99 : 1,
    data: mismatch === "other-store" ? "someone-else" : data, boot: "test",
  }) });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ port: listener.port }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "desktop"], {
    env: { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_CONFIG: config, AUTOPILOT_NOTIFY: "off", AUTOPILOT_DESKTOP: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toContain(mismatch === "other-store" ? "different data folder" : "compatible desktop support");
    expect(existsSync(join(home, "state"))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${listener.port}/desktop-info`)).status).toBe(200);
  } finally { child.kill(); listener.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("restarting a previously attached app bridge does not create a worker while the service is down", async () => {
  const home = mkdtempSync(join(tmpdir(), "autopilot-attach-only-"));
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = free.port; free.stop(true);
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ port, onboarded: false }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "desktop"], {
    env: { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_CONFIG: config, AUTOPILOT_NOTIFY: "off", AUTOPILOT_DESKTOP: "1", AUTOPILOT_DESKTOP_ATTACH_ONLY: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"disconnected"');
    reader.releaseLock();
    await Bun.sleep(1800);
    expect(existsSync(join(home, "state"))).toBe(false);
    // The port is still free for the formula to reclaim.
    const listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    listener.stop(true);
    await child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally { child.kill(); rmSync(home, { recursive: true, force: true }); }
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

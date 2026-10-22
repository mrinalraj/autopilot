import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { Store } from "../../src/storage/db";
import { Autopilot } from "../../src/app/autopilot";
import { startWeb } from "../../src/web/server";
import type { Tracker } from "../../src/trackers/tracker";
import type { LLM } from "../../src/triage/llm";

const dir = mkdtempSync(join(tmpdir(), "autopilot-web-"));
const port = 47000 + Math.floor(Math.random() * 900);
const base = `http://localhost:${port}`;
let server: ReturnType<typeof startWeb>;
let store: Store;
let cfgStateDir: string;
const health = {
  items: [
    { id: "supacode", level: "required", title: "Supacode isn't installed", detail: "needed" },
    { id: "gh-login", level: "optional", title: "Log in to gh", detail: "for PRs", command: "gh auth login" },
    { id: "install-app", level: "optional", title: "Install as an app", detail: "dock", browserOnly: true },
  ],
  refresh: async () => health.items,
};

beforeAll(() => {
  process.env.AUTOPILOT_NOTIFY = "off";
  mkdirSync(join(dir, "repos", "backend"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", join(dir, "repos", "backend")]);
  const cfg = { ...loadConfig("/nonexistent"), onboarded: true, port, repoRoots: [join(dir, "repos")], stateDir: join(dir, "state"), briefsDir: join(dir, "b") };
  store = new Store(cfg.stateDir);
  store.upsertIssue({
    linear_id: "x", identifier: "ENG-9", title: `<script>alert(1)</script>`, url: "https://linear.app/i/ENG-9",
    brief_path: join(dir, "b", "ENG-9.md"), repo: "backend", repo_path: join(dir, "repos", "backend"), branch: "fix-it-eng-9",
    confidence: 0.3, resolve_reason: "guess", status: "pending", error: null, worktree_id: null,
    ticket_json: JSON.stringify({ description: `<img src=x onerror=alert(1)>`, comments: [], team: "ENG", project: null, labels: [], attachments: [], state: "Todo" }),
    explainer_json: JSON.stringify({ summary: "sum", approach: "app", likely_areas: [], size: "S" }), extra_repos_json: "[]",
  });
  cfgStateDir = cfg.stateDir;
  const ap = new Autopilot(cfg, store, { kind: "linear", label: "Linear" } as Tracker, {} as LLM);
  // Exercise the daemon's startup listener handoff with the same security/action checks below.
  const listening = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("starting", { status: 503 }) });
  server = startWeb(ap, {
    health: health as never, configPath: join(dir, "settings.json"),
    gh: () => ({ installed: true, accounts: [{ name: "test-account", active: true }] }),
  }, listening);
  expect(server).toBe(listening);
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const csrfFrom = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1];

test("old detail links redirect to the item's modal", async () => {
  const res = await fetch(`${base}/issues/ENG-9`, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/#m-ENG-9");
});

test("card + modal escape untrusted text, set CSP and gate low confidence behind review", async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("Low confidence (30%)");
  expect(html).toContain('<div class="modal" id="m-ENG-9"');
  expect(html).toContain('<a class="btn primary" href="#m-ENG-9">Review</a>');
});

test("only the nonce'd live script may run", async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get("content-security-policy")!;
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  const html = await res.text();
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(csp).not.toContain("unsafe-inline'; script");
});

test("serves the PWA manifest, service worker, offline page and icons", async () => {
  const m = await fetch(`${base}/manifest.webmanifest`);
  expect(m.headers.get("content-type")).toBe("application/manifest+json");
  const manifest = await m.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBe(true);
  for (const icon of manifest.icons) expect((await fetch(`${base}${icon.src}`)).status).toBe(200);

  const sw = await fetch(`${base}/sw.js`);
  expect(sw.headers.get("content-type")).toBe("text/javascript");
  expect(await sw.text()).toContain('addEventListener("fetch"');
  expect((await fetch(`${base}/offline.html`)).status).toBe(200);
  expect((await fetch(`${base}/icons/../config.ts`)).status).toBe(404);

  const page = await fetch(`${base}/`);
  expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'; worker-src 'self'");
  expect(await page.text()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
});

test("state endpoint reports progress and a change version", async () => {
  const s = await (await fetch(`${base}/state`)).json();
  expect(s.polling).toBe(false);
  expect(s.progress).toEqual({ current: null, done: 0, total: 0 });
  expect(typeof s.version).toBe("string");
  expect(typeof s.awaiting).toBe("number");
});

test("setup banners: optional ones dismiss and stay dismissed, required ones can't", async () => {
  let html = await (await fetch(`${base}/`)).text();
  expect(html).toContain("Supacode isn&#39;t installed");
  expect(html).toContain("<code>gh auth login</code>");
  expect(html).toContain('class="tip optional browser-only"');
  expect(html).not.toContain('action="/banners/supacode/dismiss"');

  const csrf = csrfFrom(html);
  const post = (path: string) => fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams({ csrf }), headers: { Origin: base }, redirect: "manual" });
  expect((await post("/banners/gh-login/dismiss")).status).toBe(303);
  await post("/banners/supacode/dismiss"); // ignored: required
  html = await (await fetch(`${base}/`)).text();
  expect(html).not.toContain("Log in to gh");
  expect(html).toContain("Supacode isn&#39;t installed");
  expect(html).toContain("Show 1 dismissed tip");
  expect(new Store(cfgStateDir).dismissedBanners()).toEqual(new Set(["gh-login"])); // persisted

  await post("/banners/restore");
  expect(await (await fetch(`${base}/`)).text()).toContain("Log in to gh");
});

test("log panel is prefilled, escaped, and /events streams only newer lines", async () => {
  const { log } = await import("../../src/shared/log");
  log.info("<b>marker-one</b>");
  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain('<aside id="logs" class="logs"');
  expect(html).toContain("&lt;b&gt;marker-one&lt;/b&gt;");
  expect(html).not.toContain("<b>marker-one</b>");
  const last = Number(/id="logs" class="logs" aria-label="Activity log" data-last="(\d+)"/.exec(html)![1]);
  log.warn("marker-two");
  const fresh = await (await fetch(`${base}/events?since=${last}`)).json();
  expect(fresh.map((e: { msg: string; level: string }) => [e.level, e.msg])).toEqual([["warn", "marker-two"]]);
});

test("settings shows the Linear account section (signed out here)", async () => {
  const html = await (await fetch(`${base}/settings`)).text();
  expect(html).toContain("Linear account");
  expect(html).toContain('action="/actions/signin"');
  expect(html).toContain('<option value="linear" selected>Linear</option>');
  expect(html).toContain("Sign in to Linear");
  expect(html).toContain('value="test-account"');
  expect(html).toContain(join(dir, "settings.json"));
  expect(html).toContain('value="superset"');
});

test("rejects foreign Host headers (DNS rebinding)", async () => {
  const res = await fetch(`${base}/`, { headers: { Host: "evil.example:80" } });
  expect(res.status).toBe(403);
});

test("POST with a stale or missing CSRF token does nothing and says the page was out of date", async () => {
  const body = new URLSearchParams({ repo: "backend", branch: "x", csrf: "nope" });
  const res = await fetch(`${base}/issues/ENG-9/reject`, { method: "POST", body, redirect: "manual" });
  expect(res.status).toBe(303);
  expect(decodeURIComponent(res.headers.get("location")!)).toContain("out of date");
  expect(store.getIssueByIdentifier("ENG-9")!.status).toBe("pending");
});

test("the CSRF token is stored, so pages stay valid across restarts", async () => {
  const csrf = csrfFrom(await (await fetch(`${base}/`)).text());
  expect(store.getMeta("csrf_token")).toBe(csrf);
  const s = await (await fetch(`${base}/state`)).json();
  expect(typeof s.boot).toBe("string"); // open pages reload when this changes
});

test("a multibyte CSRF token is rejected without throwing or changing a ticket", async () => {
  const token = csrfFrom(await (await fetch(`${base}/`)).text());
  const res = await fetch(`${base}/issues/ENG-9/reject`, {
    method: "POST", body: new URLSearchParams({ csrf: "é".repeat(token.length) }), redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(decodeURIComponent(res.headers.get("location")!)).toContain("out of date");
  expect(store.getIssueByIdentifier("ENG-9")!.status).toBe("pending");
});

test("cross-origin POST is refused even with a token", async () => {
  const csrf = csrfFrom(await (await fetch(`${base}/`)).text());
  const res = await fetch(`${base}/issues/ENG-9/reject`, {
    method: "POST", body: new URLSearchParams({ csrf }), headers: { Origin: "https://evil.example" }, redirect: "manual",
  });
  expect(res.status).toBe(403);
});

test("pages keep the browser's Origin on same-origin form posts", async () => {
  const res = await fetch(`${base}/`);
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
});

test("reject via the form, as a browser sends it", async () => {
  const csrf = csrfFrom(await (await fetch(`${base}/`)).text());
  const res = await fetch(`${base}/issues/ENG-9/reject`, {
    method: "POST", body: new URLSearchParams({ csrf }), headers: { Origin: base }, redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(store.getIssueByIdentifier("ENG-9")!.status).toBe("rejected");
  expect(await (await fetch(`${base}/`)).text()).toContain(`<h2>Awaiting approval</h2><span class="count">0</span>`);
});

test("first run: no sign-in and no tickets shows the connect card instead of an error", async () => {
  const s = new Store(join(dir, "fresh"));
  const cfg = { ...loadConfig("/nonexistent"), onboarded: true, port: port + 1, stateDir: join(dir, "fresh"), briefsDir: join(dir, "fresh", "b") };
  const ap = new Autopilot(cfg, s, { kind: "linear", label: "Linear" } as Tracker, {} as LLM);
  ap.lastPollError = "Linear login required: sign in from Settings";
  const srv = startWeb(ap, { health: { items: [], refresh: async () => [] } as never });
  try {
    const html = await (await fetch(`http://localhost:${port + 1}/`)).text();
    expect(html).toContain("Connect your issue tracker");
    expect(html).toContain('<button class="primary" data-busy-label="Opening Linear…">Connect Linear</button>');
    expect(html).toContain('name="tracker" value="jira"');
    expect(html).not.toContain("Last poll failed");
  } finally {
    srv.stop(true);
  }
});

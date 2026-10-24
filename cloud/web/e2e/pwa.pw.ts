import { expect, test } from "@playwright/test";

test("packaged PWA identity, cache boundaries, offline recovery and connection loss", async ({ page, context }, info) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
  const manifest = await page.evaluate(async () => {
    const response = await fetch(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href);
    if (!response.headers.get("Content-Type")?.includes("application/manifest+json")) throw Error("wrong manifest MIME");
    return response.json();
  });
  expect(manifest).toMatchObject({ id: "/", name: "Autopilot Cloud", start_url: "/", scope: "/", display: "standalone" });
  for (const icon of manifest.icons) {
    const dimensions = await page.evaluate(async (src) => {
      const image = new Image(); image.src = src; await image.decode();
      return `${image.width}x${image.height}`;
    }, icon.src);
    expect(dimensions).toBe(icon.sizes);
  }
  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send("Page.getAppManifest");
  expect(appManifest.errors).toEqual([]);
  const eligibility = await cdp.send("Page.getInstallabilityErrors");
  expect(eligibility.installabilityErrors).toEqual([]);
  await info.attach("chromium-installability", { body: JSON.stringify({ appManifest, eligibility }, null, 2), contentType: "application/json" });
  await page.evaluate(async () => {
    await fetch("/api/v1/snapshot");
    await fetch("/api/v1/plugins");
    await fetch("/healthz");
  });
  const cached = await page.evaluate(async () => {
    const entries: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) entries.push(new URL(request.url).pathname);
    }
    return entries;
  });
  expect(cached).toEqual(["/offline.html"]);
  // Activate a new worker with an old app cache present; unrelated caches survive.
  await page.evaluate(async () => {
    await caches.open("autopilot-cloud-offline-old");
    await caches.open("unrelated-cache");
    const registration = await navigator.serviceWorker.getRegistration();
    await registration!.unregister();
    await navigator.serviceWorker.register("/service-worker.js?update-test", { updateViaCache: "none" });
  });
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("autopilot-cloud-offline-old"))).toBe(false);
  expect(await page.evaluate(async () => (await caches.keys()).includes("unrelated-cache"))).toBe(true);
  await context.setOffline(true);
  await expect(page.getByText(/Server connection lost/)).toBeVisible({ timeout: 15000 });
  const offlineRequests = await page.evaluate(async () => {
    return Promise.all(["GET", "POST"].map(async (method) => {
      try { await fetch("/api/v1/workspaces", { method, body: method === "POST" ? '{}' : undefined }); return "unexpected response"; }
      catch { return "network error"; }
    }));
  });
  expect(offlineRequests).toEqual(["network error", "network error"]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Autopilot server unavailable" })).toBeVisible();
  await expect(page.getByText(/no actions have been queued/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("offline.png") });
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Autopilot server unavailable" })).toHaveCount(0);
  await expect(page.getByText(/Opening your workspace/)).toHaveCount(0);
  const fresh = await page.evaluate(async () => (await fetch("/api/v1/snapshot")).headers.get("Cache-Control"));
  expect(fresh).toBe("no-store");
});

test("an old window can recover after a UI chunk is removed by an upgrade", async ({ page, request }, info) => {
  const snapshot = async () => (await request.get("/api/v1/snapshot")).json();
  const before = await snapshot();
  const headers = { "X-CSRF-Token": before.csrf };
  const response = await request.post("/api/v1/workspaces", { headers, data: {
    name: "PWA update recovery", workerHarness: "test-agent", orchestratorHarness: "test-agent",
  } });
  expect(response.ok()).toBe(true);
  const workspace = await response.json();
  try {
    await page.route("**/assets/Terminal-*.js", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "old chunk removed" }));
    await page.goto("/");
    await page.getByLabel("Active workspace").selectOption(workspace.id);
    await page.getByRole("button", { name: "Coordinator", exact: true }).click();
    await expect(page.getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    const session = (await snapshot()).sessions.find((s: any) => s.workspaceId === workspace.id);
    expect(session).toBeTruthy();
    await page.screenshot({ path: info.outputPath("update-recovery.png") });
    await page.unroute("**/assets/Terminal-*.js");
    await page.getByRole("button", { name: "Reload interface" }).click();
    await page.getByRole("button", { name: "Coordinator", exact: true }).click();
    await expect(page.locator(".coordinator-screen .terminal-panel")).toHaveAttribute("data-connection", "Connected");
    expect((await snapshot()).sessions.filter((s: any) => s.workspaceId === workspace.id).map((s: any) => s.id)).toEqual([session.id]);
  } finally {
    const current = await snapshot();
    for (const session of current.sessions.filter((s: any) => s.workspaceId === workspace.id)) {
      await request.post(`/api/v1/sessions/${session.id}/stop`, { headers, data: {} });
    }
    await request.delete(`/api/v1/workspaces/${workspace.id}`, { headers, data: { revision: workspace.revision } });
  }
});

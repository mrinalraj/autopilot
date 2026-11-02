import { test, expect } from "@playwright/test";

test.beforeEach(({ page }) => page.setDefaultTimeout(5000));

test("Classic is the default; theme choice persists and syncs between windows", async ({
  page,
  context,
}, info) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(17, 18, 22)",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue(
    "classic",
  );
  await page.screenshot({ path: info.outputPath("classic-appearance.png") });

  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("sage");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(42, 48, 41)",
  );
  await expect(other.getByLabel("Theme", { exact: true })).toHaveValue("sage");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#2a3029",
  );
  await page.screenshot({ path: info.outputPath("sage-appearance.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("sage");
  await page.getByLabel("Theme", { exact: true }).selectOption("ember");
  await expect(other.getByLabel("Theme", { exact: true })).toHaveValue("ember");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#101010",
  );
  await page.screenshot({ path: info.outputPath("ember-appearance.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("ember");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("mobile-appearance.png") });
  await page.getByLabel("Theme", { exact: true }).selectOption("classic");
  await expect(other.getByLabel("Theme", { exact: true })).toHaveValue(
    "classic",
  );
  await expect(other.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(17, 18, 22)",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#111216",
  );
  await other.close();
});

test("saved theme is applied before the app starts; invalid preferences fall back", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("autopilot.theme", "sage"),
  );
  // Block React's bundle: the external head script must still apply the preference.
  await page.route("**/assets/index-*.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await expect(page.locator("#root")).toBeEmpty();
  await page.unroute("**/assets/index-*.js");
  await page.evaluate(() =>
    localStorage.setItem("autopilot.theme", "unknown-theme"),
  );
  const fallback = await page.context().newPage();
  await fallback.goto("/");
  await expect(fallback.locator("html")).toHaveAttribute(
    "data-theme",
    "classic",
  );
  await fallback.close();
});

test("theme storage failure does not prevent switching in the current window", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "autopilot.theme")
        throw new DOMException("Unavailable", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "autopilot.theme")
        throw new DOMException("Unavailable", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("sage");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("sage");
});

test("live terminals change theme without reconnecting", async ({
  page,
  context,
  request,
}, info) => {
  const initial = await (await request.get("/api/v1/snapshot")).json();
  const headers = { "X-CSRF-Token": initial.csrf };
  const created = await request.post("/api/v1/workspaces", {
    headers,
    data: {
      name: "Theme terminal test",
      workerHarness: "test-agent",
      orchestratorHarness: "test-agent",
    },
  });
  expect(created.ok()).toBe(true);
  const workspace = await created.json();
  let sockets = 0,
    closed = 0;
  page.on("websocket", (socket) => {
    sockets++;
    socket.on("close", () => closed++);
  });
  try {
    await page.goto("/");
    await page.getByLabel("Active workspace").selectOption(workspace.id);
    await page
      .getByRole("button", { name: "Coordinator", exact: true })
      .click();
    await expect(page.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    const terminal = await page.locator(".xterm").elementHandle();
    const connected = sockets;
    const settings = await context.newPage();
    await settings.goto("/");
    await settings
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    for (const [theme, background] of [
      ["sage", "rgb(42, 48, 41)"],
      ["ember", "rgb(16, 16, 16)"],
      ["classic", "rgb(16, 17, 21)"],
    ]) {
      await settings.getByLabel("Theme", { exact: true }).selectOption(theme);
      await expect(page.locator(".xterm-viewport")).toHaveCSS(
        "background-color",
        background,
      );
      await expect(page.locator(".terminal-panel")).toHaveAttribute(
        "data-connection",
        "Connected",
      );
      expect(await terminal!.evaluate((el) => el.isConnected)).toBe(true);
      expect(sockets).toBe(connected);
      expect(closed).toBe(0);
      await page.screenshot({
        path: info.outputPath(`live-terminal-${theme}.png`),
      });
    }
    await settings.close();
  } finally {
    const snapshot = await (await request.get("/api/v1/snapshot")).json();
    for (const session of snapshot.sessions.filter(
      (s: any) => s.workspaceId === workspace.id,
    ))
      await request.post(`/api/v1/sessions/${session.id}/stop`, {
        headers,
        data: {},
      });
    await request.delete(`/api/v1/workspaces/${workspace.id}`, {
      headers,
      data: { revision: workspace.revision },
    });
  }
});

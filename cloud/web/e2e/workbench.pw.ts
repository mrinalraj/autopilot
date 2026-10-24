import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("browse every checkout, create manual work, use shell and configure a tracker", async ({
  page,
  request,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-workbench-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { stdio: "ignore" });
  const snapshot = async () =>
    await (await request.get("/api/v1/snapshot")).json();
  let workspaceID = "";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const repo = join(root, "engine");
    git("init", "-b", "main", repo);
    git(
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    git(
      "-C",
      repo,
      "worktree",
      "add",
      "-b",
      "external-ticket",
      join(root, "external"),
    );
    await page.goto("/");
    const before = await snapshot();
    const imported = await request.post("/api/v1/workspaces/import", {
      headers: { "X-CSRF-Token": before.csrf },
      data: { name: "Workbench test", root, repositoryPaths: [repo] },
    });
    expect(imported.ok()).toBe(true);
    await page.reload();
    const ws = (await snapshot()).workspaces.find(
      (w: any) => w.name === "Workbench test",
    );
    workspaceID = ws.id;
    await page.getByLabel("Active workspace").selectOption(ws.id);
    await expect(
      page.locator(".worktree-nav").filter({ hasText: "(default) main" }),
    ).toBeVisible();
    await expect(
      page.locator(".worktree-nav").filter({ hasText: "external" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New worktree in engine", exact: true })
      .click();
    await page.getByLabel("Worktree name", { exact: true }).fill("Manual work");
    await expect(page.getByLabel("Base branch", { exact: true })).toHaveValue(
      "refs/heads/main",
    );
    await page
      .getByRole("button", { name: "Create worktree", exact: true })
      .click();
    await expect(page.locator(".header-branch")).toContainText("manual-work");
    const made = await snapshot();
    expect(made.plans.length).toBe(before.plans.length);
    expect(made.runs.length).toBe(before.runs.length);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    await expect(
      page.getByRole("button", { name: "Take control" }),
    ).toHaveCount(0);
    await page
      .locator(".xterm-helper-textarea")
      .pressSequentially("printf 'WORKBENCH_%s\\n' VERIFIED");
    await page.locator(".xterm-helper-textarea").press("Enter");
    const shell = (await snapshot()).sessions.find(
      (s: any) => s.kind === "shell",
    );
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/v1/sessions/${shell.id}/preview`)
            ).json()
          ).preview,
      )
      .toContain("WORKBENCH_VERIFIED");
    await page.screenshot({
      path: info.outputPath("worktree-terminal-desktop.png"),
      fullPage: true,
    });
    await page
      .locator(".worktree-nav")
      .filter({ hasText: "(default) main" })
      .click();
    await page
      .locator(".worktree-nav")
      .filter({ hasText: "Manual work" })
      .click();
    await expect(page.locator(".xterm-screen")).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByText("Session stopped. Open a terminal or agent below."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Test Agent", exact: true }).click();
    await expect(page.locator(".session-tab-list button.active")).toContainText(
      "Test Agent",
    );
    await expect(page.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    await page.getByRole("button", { name: "Toggle changes sidebar" }).click();
    await expect(page.locator(".worktree-inspector")).toBeVisible();
    await page.screenshot({
      path: info.outputPath("terminal-with-changes.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close sidebar", exact: true })
      .click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page
      .getByRole("button", { name: "Coordinator", exact: true })
      .click();
    await expect(
      page.locator(".coordinator-screen .terminal-panel"),
    ).toHaveAttribute("data-connection", "Connected");
    await page.screenshot({
      path: info.outputPath("coordinator-terminal.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Connect integration" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("plugins-desktop.png"),
      fullPage: true,
    });
    await page
      .locator(".plugin-card")
      .filter({
        has: page.getByRole("heading", { name: "Linear", exact: true }),
      })
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await page
      .getByLabel("Connection name", { exact: true })
      .fill("Product tracker");
    await page
      .getByLabel("Access token", { exact: true })
      .fill("fake-test-token");
    await page.getByLabel("Enabled", { exact: true }).uncheck();
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Signed webhooks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Poll interval (seconds)", { exact: true }),
    ).toHaveValue("60");
    await page.screenshot({
      path: info.outputPath("tracker-settings-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath("tracker-settings-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (workspaceID) {
      const current = await snapshot();
      const ws = current.workspaces.find((w: any) => w.id === workspaceID);
      if (ws) {
        for (const s of current.sessions.filter(
          (s: any) => s.workspaceId === workspaceID,
        ))
          await request.post(`/api/v1/sessions/${s.id}/stop`, {
            headers: { "X-CSRF-Token": current.csrf },
            data: {},
          });
        const removed = await request.delete(
          `/api/v1/workspaces/${workspaceID}`,
          {
            headers: { "X-CSRF-Token": current.csrf },
            data: { revision: ws.revision },
          },
        );
        expect(removed.ok()).toBe(true);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

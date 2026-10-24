import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("native board → approved plan → isolated worker → terminal reconnect", async ({
  page,
  request,
}, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), "autopilot-fixture-"));
  try {
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", [
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
    ]);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Workspace name", { exact: true })
      .fill("Autopilot Engineering");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Attach existing", exact: true })
      .click();
    await page.getByLabel("Repository path", { exact: true }).fill(repo);
    await page
      .getByRole("button", { name: "Attach repository", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.getByRole("button", { name: /^New issue/ }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Build a cloud agent workspace");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Keep tracker and agent execution in one place.");
    await page
      .getByRole("button", { name: "Create issue", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const card = page
      .getByRole("button")
      .filter({ hasText: "Build a cloud agent workspace" });
    await expect(card).toBeVisible();
    const cols = page.locator(".flow-lane");
    await expect(cols).toHaveCount(5);
    const first = await cols.nth(0).boundingBox(),
      second = await cols.nth(1).boundingBox();
    expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1);
    await page.screenshot({
      path: testInfo.outputPath("kanban-desktop.png"),
      fullPage: true,
    });
    await card.click();
    await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Priority", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Plan this issue", exact: true })
      .click();
    await page
      .getByLabel("Worker harness", { exact: true })
      .selectOption("test-agent");
    await page.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Needs you", exact: true }),
    ).toContainText("Build a cloud agent workspace");
    await page
      .getByRole("button", { name: /Review plan/ })
      .first()
      .click();
    await page.getByRole("button", { name: /Approve/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.locator(".worktree-nav").filter({ hasText: "autopilot/" }),
    ).toBeVisible({ timeout: 15000 });
    await page
      .locator(".worktree-nav")
      .filter({ hasText: "autopilot/" })
      .click();
    await expect(page.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    await page
      .locator(".xterm-helper-textarea")
      .pressSequentially("browser follow-up");
    await page.locator(".xterm-helper-textarea").press("Enter");
    const snap = await (await request.get("/api/v1/snapshot")).json();
    expect(snap.runs).toHaveLength(1);
    const sid = snap.sessions.find((s: any) => s.role === "worker").id;
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/v1/sessions/${sid}/preview`)).json())
            .preview,
      )
      .toContain("RECEIVED browser follow-up");
    const viewer = await page.context().newPage();
    await viewer.goto("/");
    await expect(viewer.getByLabel("Issue board")).toBeVisible();
    await viewer
      .locator(".worktree-nav")
      .filter({ hasText: "autopilot/" })
      .click();
    await expect(viewer.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    await viewer
      .locator(".xterm-helper-textarea")
      .pressSequentially("second viewer input");
    await viewer.locator(".xterm-helper-textarea").press("Enter");
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/v1/sessions/${sid}/preview`)).json())
            .preview,
      )
      .toContain("RECEIVED second viewer input");
    await viewer.close();
    await page.reload();
    await expect(page.getByLabel("Issue board")).toBeVisible();
    await page
      .locator(".worktree-nav")
      .filter({ hasText: "autopilot/" })
      .click();
    await expect(page.locator(".terminal-panel")).toHaveAttribute(
      "data-connection",
      "Connected",
    );
    const fresh = await (await request.get("/api/v1/snapshot")).json();
    expect(fresh.sessions.some((s: any) => s.id === sid)).toBe(true);
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("kanban-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("import selected repositories, cancel removal, then unregister without deleting code", async ({
  page,
  request,
}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-import-"));
  try {
    for (const name of ["alpha", "beta"]) {
      execFileSync("git", ["init", "-b", "main", join(root, name)]);
    }
    mkdirSync(join(root, "not-a-repository"));
    execFileSync("git", [
      "-C",
      join(root, "alpha"),
      "remote",
      "add",
      "origin",
      "https://github.com/example/long-repository-name-for-workspace-layout-verification.git",
    ]);
    const note = join(root, "alpha", "uncommitted.txt");
    writeFileSync(note, "preserve this work");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    const before = await (await request.get("/api/v1/snapshot")).json();
    await page.getByLabel("Active workspace").selectOption("@import");
    const dialog = page.getByRole("dialog");
    await page
      .getByLabel("Workspace directory", { exact: true })
      .fill(join(root, "missing"));
    await page
      .getByRole("button", { name: "Scan folder", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await page.getByLabel("Workspace directory", { exact: true }).fill(root);
    await page
      .getByRole("button", { name: "Scan folder", exact: true })
      .click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(2);
    await dialog.getByRole("checkbox", { name: /^beta/ }).uncheck();
    await page
      .getByLabel("Workspace name", { exact: true })
      .fill("Imported engineering");
    await page.screenshot({
      path: testInfo.outputPath("import-workspace-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("import-workspace-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const scanned = await (await request.get("/api/v1/snapshot")).json();
    expect(scanned.workspaces.length).toBe(before.workspaces.length);
    await dialog
      .getByRole("button", { name: "Import workspace", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Imported engineering", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "alpha", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "beta", exact: true }),
    ).toHaveCount(0);
    const imported = await (await request.get("/api/v1/snapshot")).json();
    for (const width of [1440, 900, 700, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const row = page.locator(".repo-row").first();
      const text = await row.locator(".grow").boundingBox();
      expect(text!.width).toBeGreaterThan(180);
      expect((await row.boundingBox())!.height).toBeLessThan(320);
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`repository-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const workspace = imported.workspaces.find(
      (w: any) => w.name === "Imported engineering",
    );
    expect(
      imported.repositories.filter((r: any) => r.workspaceId === workspace.id),
    ).toHaveLength(1);
    const viewer = await page.context().newPage();
    await viewer.goto("/");
    await expect(viewer.getByLabel("Active workspace")).toHaveValue(
      workspace.id,
    );
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Imported engineering", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Remove workspace", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Imported engineering", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Remove workspace", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove workspace", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const after = await (await request.get("/api/v1/snapshot")).json();
    await expect(viewer.getByLabel("Active workspace")).not.toHaveValue(
      workspace.id,
    );
    await viewer.close();
    expect(after.workspaces.map((w: any) => w.id)).toEqual(
      before.workspaces.map((w: any) => w.id),
    );
    expect(
      after.repositories.filter((r: any) => r.workspaceId === workspace.id),
    ).toHaveLength(0);
    expect(readFileSync(note, "utf8")).toBe("preserve this work");
    expect(
      execFileSync(
        "git",
        ["-C", join(root, "beta"), "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("true");
    expect(errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
test("coordinator automatically plans new tickets and receives the next ticket once", async ({
  page,
  request,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), "ap-triage-"));
  let workspace: any;
  const snapshot = async () =>
    await (await request.get("/api/v1/snapshot")).json();
  const initial = await snapshot();
  const headers = { "X-CSRF-Token": initial.csrf };
  try {
    execFileSync("git", ["init", "-b", "main", join(root, "repo")], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-C",
        join(root, "repo"),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=t@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { stdio: "ignore" },
    );
    const response = await request.post("/api/v1/workspaces/import", {
      headers,
      data: {
        name: "Automatic triage",
        root,
        repositoryPaths: [join(root, "repo")],
        workerHarness: "test-agent",
        orchestratorHarness: "test-planner",
      },
    });
    expect(response.ok()).toBe(true);
    workspace = await response.json();
    await page.goto("/");
    await page.getByLabel("Active workspace").selectOption(workspace.id);
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    for (const title of ["First incoming ticket", "Next incoming ticket"]) {
      await page
        .getByRole("button", { name: "New issue", exact: true })
        .click();
      await page.getByLabel("Title", { exact: true }).fill(title);
      await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Priority", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Project", { exact: true })).toHaveCount(0);
      await page
        .getByRole("button", { name: "Create issue", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Needs you", exact: true }),
      ).toContainText(title, { timeout: 15000 });
    }
    const s = await snapshot();
    expect(
      s.plans.filter((p: any) => p.workspaceId === workspace.id),
    ).toHaveLength(2);
    expect(
      s.runs.filter((r: any) => r.workspaceId === workspace.id),
    ).toHaveLength(0);
    expect(
      s.sessions.filter(
        (x: any) => x.workspaceId === workspace.id && x.role === "orchestrator",
      ),
    ).toHaveLength(1);
    await page.screenshot({
      path: info.outputPath("automatic-flow-board.png"),
      fullPage: true,
    });
    await page
      .getByRole("button")
      .filter({ hasText: "First incoming ticket" })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Review plan", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Review plan", exact: true })
      .click();
    await expect(page.getByLabel("Plan title", { exact: true })).toHaveValue(
      "Plan: First incoming ticket",
    );
  } finally {
    if (workspace) {
      const s = await snapshot();
      for (const x of s.sessions.filter(
        (x: any) => x.workspaceId === workspace.id,
      ))
        await request.post(`/api/v1/sessions/${x.id}/stop`, {
          headers,
          data: {},
        });
      await request.delete(`/api/v1/workspaces/${workspace.id}`, {
        headers,
        data: { revision: workspace.revision },
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

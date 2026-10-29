import { test, expect, Page } from "@playwright/test";

// Measure rendered text against composited ancestor backgrounds, including hover.
// This catches missed component rules that palette-token checks cannot detect.
async function contrastFailures(page: Page) {
  return page.evaluate(() => {
    const rgba = (s: string) => {
      const n = s.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
      return [n[0], n[1], n[2], n[3] ?? 1];
    };
    const over = (a: number[], b: number[]) =>
      [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
    const luminance = (c: number[]) =>
      c
        .slice(0, 3)
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const failures: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (
        el.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        el.closest('.xterm, [aria-hidden="true"], .sr-only, :disabled') ||
        (![...el.childNodes].some(
          (n) => n.nodeType === 3 && n.textContent?.trim(),
        ) &&
          !el.matches("input, textarea, select"))
      )
        continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (
        !box.width ||
        !box.height ||
        box.bottom <= 0 ||
        box.top >= innerHeight ||
        box.right <= 0 ||
        box.left >= innerWidth ||
        style.visibility === "hidden" ||
        el.closest("dialog:not([open])")
      )
        continue;
      const dialog = document.querySelector("dialog[open]");
      if (dialog && !dialog.contains(el)) continue;
      const stack: HTMLElement[] = [];
      for (let p: HTMLElement | null = el; p; p = p.parentElement)
        stack.unshift(p);
      if (stack.some((p) => Number(getComputedStyle(p).opacity) < 1)) continue;
      let bg = [255, 255, 255, 1];
      for (const p of stack)
        bg = over(rgba(getComputedStyle(p).backgroundColor), bg);
      const fg = over(rgba(style.color), bg);
      const a = luminance(fg),
        b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 &&
          Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        failures.push(
          `${el.tagName}.${el.className} ${el.textContent?.trim().slice(0, 45)}: ${ratio.toFixed(2)} (${style.color})`,
        );
    }
    return [...new Set(failures)];
  });
}

for (const theme of ["sage", "ember"]) {
  test(`${theme} theme stays readable across surfaces, hover, focus and mobile`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120_000);
    await page.addInitScript(
      (theme) => localStorage.setItem("autopilot.theme", theme),
      theme,
    );
    const initial = await (await request.get("/api/v1/snapshot")).json();
    const meta = {
      revision: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const workspace = {
      ...meta,
      id: "theme-ws",
      name: "Studio",
      root: "/tmp/theme",
      workerHarness: "test-agent",
      orchestratorHarness: "test-agent",
    };
    const task = {
      id: "task",
      title: "Polish the workbench",
      prompt: "Check every interaction.",
      repositoryIds: ["theme-repo"],
      dependsOn: [],
      harness: "test-agent",
      issueId: "issue-2",
    };
    const snapshot = {
      ...initial,
      workspaces: [workspace],
      repositories: [
        {
          ...meta,
          id: "theme-repo",
          workspaceId: workspace.id,
          name: "autopilot",
          path: "/tmp/theme/autopilot",
          remote: "",
          defaultBranch: "main",
          provider: "native",
          setup: [],
        },
      ],
      worktrees: [
        {
          ...meta,
          id: "theme-tree",
          workspaceId: workspace.id,
          repositoryId: "theme-repo",
          name: "Palette polish",
          path: "/tmp/theme/palette",
          branch: "palette-polish",
          base: "main",
          primary: true,
          status: "present",
          issueIds: [],
        },
      ],
      issues: ["triage", "working", "needs_you", "in_review", "done"].map(
        (state, i) => ({
          ...meta,
          id: `issue-${i}`,
          workspaceId: workspace.id,
          identifier: `APP-${i + 1}`,
          title: [
            "Import repository settings",
            "Improve terminal reconnect",
            "Polish the workbench",
            "Review workspace permissions",
            "Ship onboarding",
          ][i],
          description: "Check the interface across surfaces.",
          workflowState: state,
          workflowDetail: [
            "Waiting for coordinator",
            "Agent is working",
            "Plan awaiting approval",
            "Checks are passing",
            "Completed",
          ][i],
          planIds: i === 2 ? ["theme-plan"] : [],
          status: "backlog",
          labels: [],
          source: "native",
        }),
      ),
      plans: [
        {
          ...meta,
          id: "theme-plan",
          workspaceId: workspace.id,
          issueId: "issue-2",
          title: "Polish the workbench",
          summary: "Check contrast and interactions.",
          state: "draft",
          tasks: [task],
        },
      ],
      sessions: [],
      runs: [],
      changes: [],
      integrations: [],
      comments: [],
      actions: [],
      executions: [],
      queue: [],
      projects: [],
    };
    await page.route("**/api/v1/snapshot", (r) =>
      r.fulfill({ json: snapshot }),
    );
    await page.route("**/api/v1/repositories/theme-repo/branches", (r) =>
      r.fulfill({ json: ["refs/heads/main"] }),
    );
    await page.route("**/api/v1/worktrees/theme-tree/changes", (r) =>
      r.fulfill({
        json: { status: " M src/theme.css", diff: "+ readable interface" },
      }),
    );
    await page.route("**/api/v1/worktrees/theme-tree/review", (r) =>
      r.fulfill({
        json: {
          change: {
            state: "open",
            title: "Polish the workbench",
            url: "https://example.test/review",
            checks: "passing",
            feedback: [],
          },
          mergeability: "clean",
          comments: [
            {
              id: "review-comment",
              body: "The new surface colors are ready for review.",
            },
          ],
        },
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const check = async (name: string, hover = true) => {
      await page.screenshot({
        path: info.outputPath(`${name}.png`),
        fullPage: true,
      });
      expect.soft(await contrastFailures(page), name).toEqual([]);
      if (!hover) return;
      const buttons = page.locator(
        (await page.locator(".repo-menu[open]").count())
          ? ".repo-menu[open] button:not(:disabled), .repo-menu[open] summary"
          : "button:visible:not(:disabled), summary:visible, a:visible",
      );
      for (let i = 0; i < (await buttons.count()); i++) {
        const button = buttons.nth(i);
        if (
          (await page.locator("dialog[open]").count()) &&
          !(await button.evaluate((el) => !!el.closest("dialog")))
        )
          continue;
        await button.hover({ timeout: 3000 });
        expect
          .soft(
            await contrastFailures(page),
            `${name} hover ${await button.textContent()}`,
          )
          .toEqual([]);
      }
    };
    await page.goto("/");
    await expect(page.locator(".flow-card")).toHaveCount(5);
    await check("board");
    const active = page.locator(".nav.active");
    const selected = await active.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await active.hover();
    expect(
      await active.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(selected);
    await page.locator(".repo-menu summary").click();
    await check("repository-menu");
    await page.locator(".repo-menu summary").click();
    await page
      .getByRole("button", { name: "New worktree in autopilot", exact: true })
      .click();
    await check("worktree-dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New issue", exact: true }).click();
    await check("issue-dialog");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Review plan", exact: true })
      .click();
    await check("plan-dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Plans", exact: true }).click();
    await check("plans");
    await page.locator(".worktree-nav").click();
    await check("terminal-empty");
    await page.getByRole("button", { name: "Toggle changes sidebar" }).click();
    await expect(page.locator(".code-output").first()).toContainText(
      "src/theme.css",
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".review-comment")).toBeVisible();
    await check("terminal-inspector");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await check("terminal-activity");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await check("general");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".profile-editor summary").first().click();
    await check("agents");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await check("terminal-settings");
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await check("plugins");
    await page
      .locator(".plugin-card")
      .filter({
        has: page.getByRole("heading", { name: "Linear", exact: true }),
      })
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await check("connection-dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await check("workspace");
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .first()
      .click();
    await check("repository-dialog");
    await page
      .getByRole("button", { name: "Attach existing", exact: true })
      .click();
    await check("repository-attach");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await check("mobile-workspace", false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const action = page.locator(".primary:visible").first();
    await action.focus();
    expect(
      await action.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe("solid");
    const bounds = (await action.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    expect(await action.evaluate((el) => getComputedStyle(el).transform)).toBe(
      "none",
    );
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await check("mobile-navigation", false);
    expect(errors).toEqual([]);
  });
}

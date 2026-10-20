import { existsSync } from "node:fs";
import type { Config } from "./config";
import { notifyState } from "./notify";
import { ghEnv } from "./work";

/** Something the setup is missing, shown as a banner on the home screen until it's fixed. */
export interface SetupItem {
  id: string;
  /** Required items block core features and can't be dismissed. */
  level: "required" | "optional";
  title: string;
  detail: string;
  command?: string;
  /** Hidden by CSS when the page runs as the installed app. */
  browserOnly?: boolean;
}

const ok = (argv: string[], env?: Record<string, string | undefined>) => {
  try {
    return Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore", env: env ?? process.env }).exitCode === 0;
  } catch {
    return false;
  }
};

/** Checks the optional and required pieces around the daemon; cheap enough to rerun every few minutes. */
export class Health {
  items: SetupItem[] = [];

  constructor(private readonly cfg: Config) {}

  async refresh(): Promise<SetupItem[]> {
    const items: SetupItem[] = [];

    if (this.cfg.llm.provider === "cli" && !ok([this.cfg.llm.claudeBin, "--version"])) {
      items.push({
        id: "claude",
        level: "required",
        title: "Claude Code CLI not found",
        detail: `Tickets are triaged with \`${this.cfg.llm.claudeBin} -p\`, and approved ones open a Claude Code session. Install Claude Code, run it once to log in, then click Poll now.`,
      });
    }
    const has = (bin: string) => !!Bun.which(bin, { PATH: process.env.PATH });
    const app = (name: string) => existsSync(`/Applications/${name}.app`) || existsSync(`${process.env.HOME}/Applications/${name}.app`);
    const launcher = this.cfg.launch.launcher;
    const missing: Record<string, [boolean, string, string]> = {
      supacode: [!existsSync(this.cfg.launch.supacodeBin) && !app("supacode"), "Supacode isn't installed", "Approving a ticket creates its worktree and Claude session in Supacode."],
      worktrunk: [!has("wt"), "Worktrunk (wt) isn't installed", "The Worktrunk launcher creates worktrees with `wt switch --create`."],
      vscode: [!app("Visual Studio Code"), "VS Code isn't installed", "The VS Code launcher opens each ticket's worktrees as a VS Code workspace."],
      cursor: [!app("Cursor"), "Cursor isn't installed", "The Cursor launcher opens each ticket's worktrees as a Cursor workspace."],
      git: [!has("git"), "git isn't installed", "The git launcher creates worktrees with `git worktree add`."],
    };
    const [isMissing, title, why] = missing[launcher];
    if (isMissing) {
      items.push({ id: `launcher-${launcher}`, level: "required", title, detail: `${why} Install it, or pick another launcher in Settings. Approvals fail until then.` });
    }
    const term = this.cfg.launch.terminal;
    const termApp: Record<string, string> = { iterm: "iTerm", warp: "Warp" };
    if (launcher !== "supacode" && termApp[term] && !app(termApp[term])) {
      items.push({
        id: `terminal-${term}`,
        level: "required",
        title: `${termApp[term]} isn't installed`,
        detail: `Claude sessions open in ${termApp[term]} per Settings. Install it, or pick another terminal in Settings.`,
      });
    }
    if (this.cfg.repoMode === "list" && this.cfg.repoPaths.length === 0) {
      items.push({ id: "repos-empty", level: "required", title: "No repos selected", detail: "Settings → Repos is set to specific repos, but the list is empty, so tickets can't be routed." });
    }

    if (!Bun.which("gh", { PATH: process.env.PATH })) {
      items.push({
        id: "gh-install",
        level: "optional",
        title: "Track pull requests with the GitHub CLI",
        detail: "Install gh and log in to see each launched ticket's PR (open, draft, merged) on its card.",
        command: "brew install gh && gh auth login",
      });
    } else {
      const user = this.cfg.githubUser;
      const loggedIn = user
        ? await ghEnv(user).then((env) => ok(["gh", "api", "user", "--jq", ".login"], env), () => false)
        : ok(["gh", "auth", "status", "-h", "github.com"]);
      if (!loggedIn) {
        items.push({
          id: "gh-login",
          level: "optional",
          title: user ? `GitHub CLI isn't logged in as ${user}` : "Log in to the GitHub CLI to track pull requests",
          detail: "PR status on launched tickets comes from gh. Log in with an account that can see your repos" +
            (user ? ` (githubUser in config.json is "${user}").` : "."),
          command: user ? `gh auth login  # as ${user}` : "gh auth login",
        });
      }
    }

    if (!Bun.which("terminal-notifier", { PATH: process.env.PATH }) && !existsSync("/opt/homebrew/bin/terminal-notifier") && !existsSync("/usr/local/bin/terminal-notifier")) {
      items.push({
        id: "notifier-install",
        level: "optional",
        title: "Clickable notifications",
        detail: "With terminal-notifier, clicking a new-ticket notification opens it here. Without it, notifications are plain.",
        command: "brew install terminal-notifier",
      });
    } else if (notifyState.permissionDenied) {
      items.push({
        id: "notifier-permission",
        level: "optional",
        title: "Notifications are blocked for terminal-notifier",
        detail: "Run this once and click Allow, or enable it in System Settings → Notifications → terminal-notifier.",
        command: "terminal-notifier -title linear-autopilot -message test",
      });
    }

    items.push({
      id: "install-app",
      level: "optional",
      title: "Install as an app",
      detail: "Get its own window and a Dock badge with the number of tickets waiting. Chrome: the install icon in the address bar. Safari: File → Add to Dock. Use localhost, not 127.0.0.1.",
      browserOnly: true,
    });

    this.items = items;
    return items;
  }
}

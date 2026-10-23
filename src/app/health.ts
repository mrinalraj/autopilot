import { repoSources } from "../repos/catalog";
import { existsSync, readdirSync } from "node:fs";
import type { Config } from "../config/config";
import { notifyState } from "../platform/notify";
import { run, shellQuote } from "../workspaces/common";
import { ghEnv } from "../workspaces/work";
import { isDesktop } from "../platform/desktop";

/** Something the setup is missing, shown as a banner on the home screen until it's fixed. */
export interface SetupItem {
  id: string;
  /** Required items block core features and can't be dismissed; hints are small, dismissible suggestions. */
  level: "required" | "optional" | "hint";
  /** Optional link shown with the item (e.g. where to get an app). */
  link?: { href: string; label: string };
  /** Optional one-click action, posted to this daemon path. */
  action?: { path: string; label: string; busy: string };
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

/**
 * Whether VS Code/Cursor already trusts `folder` (or a parent), read-only from the editor's own
 * state database. Best effort: any problem reading it counts as "not trusted".
 */
export function editorTrusts(
  editorName: "vscode" | "cursor",
  folder: string,
  db = `${process.env.HOME}/Library/Application Support/${editorName === "vscode" ? "Code" : "Cursor"}/User/globalStorage/state.vscdb`,
): boolean {
  if (!existsSync(db)) return false;
  try {
    const p = Bun.spawnSync(["sqlite3", "-readonly", db, "select value from ItemTable where key = 'content.trust.model.key';"], { stdout: "pipe", stderr: "ignore" });
    const raw = p.stdout.toString().trim();
    if (!raw) return false;
    const info = (JSON.parse(raw).uriTrustInfo ?? []) as { uri: string | { path?: string; scheme?: string }; trusted: boolean }[];
    const target = folder.replace(/\/$/, "");
    return info.some((t) => {
      if (!t.trusted) return false;
      const path = typeof t.uri === "string" ? decodeURIComponent(t.uri.replace(/^file:\/\//, "")) : t.uri.path ?? "";
      const p = path.replace(/\/$/, "");
      return p !== "" && (target === p || target.startsWith(`${p}/`));
    });
  } catch {
    return false;
  }
}

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
      superset: [!has(this.cfg.launch.supersetBin), "Superset CLI isn't installed", "Approving a ticket creates a local Superset workspace and starts Claude in its terminal."],
      worktrunk: [!has("wt"), "Worktrunk (wt) isn't installed", "The Worktrunk launcher creates worktrees with `wt switch --create`."],
      vscode: [!app("Visual Studio Code"), "VS Code isn't installed", "The VS Code launcher opens each ticket's worktrees as a VS Code workspace."],
      cursor: [!app("Cursor"), "Cursor isn't installed", "The Cursor launcher opens each ticket's worktrees as a Cursor workspace."],
      git: [!has("git"), "git isn't installed", "The git launcher creates worktrees with `git worktree add`."],
    };
    const [isMissing, title, why] = missing[launcher];
    if (isMissing) {
      items.push({ id: `launcher-${launcher}`, level: "required", title, detail: `${why} Install it, or pick another launcher in Settings. Approvals fail until then.` });
    }
    if (launcher === "superset" && !isMissing) {
      try {
        // `status` can reject the desktop app's PID even while its host serves requests.
        // Probe the same local API the launcher needs, without relying on process metadata.
        const projects = JSON.parse(await run([this.cfg.launch.supersetBin, "projects", "list", "--local", "--json"], 5_000));
        if (!Array.isArray(projects)) throw new Error("Superset returned an invalid project list");
      } catch {
        items.push({ id: "superset-host", level: "required", title: "Autopilot can't connect to Superset",
          detail: "Open Superset and sign in; the desktop app starts its local host automatically. If it's already open, check that the CLI uses the same account and organization. For CLI-only use, run `superset start --daemon` to start the host in the background. The command below checks the connection.",
          command: `${shellQuote(this.cfg.launch.supersetBin)} projects list --local --json` });
      }
    }
    const term = this.cfg.launch.terminal;
    const termApp: Record<string, string> = { iterm: "iTerm", warp: "Warp" };
    if (launcher !== "supacode" && launcher !== "superset" && termApp[term] && !app(termApp[term])) {
      items.push({
        id: `terminal-${term}`,
        level: "required",
        title: `${termApp[term]} isn't installed`,
        detail: `Claude sessions open in ${termApp[term]} per Settings. Install it, or pick another terminal in Settings.`,
      });
    }
    // Chat in the editor needs the Claude Code extension there (except Cursor's own chat).
    const needsExtension =
      (launcher === "vscode" || (launcher === "cursor" && this.cfg.launch.cursorChat === "claude")) && this.cfg.launch.ideSession === "chat";
    if (needsExtension) {
      const dir = `${process.env.HOME}/${launcher === "vscode" ? ".vscode" : ".cursor"}/extensions`;
      const installed = existsSync(dir) && readdirSync(dir).some((d) => d.startsWith("anthropic.claude-code-"));
      if (!installed) {
        const editorName = launcher === "vscode" ? "VS Code" : "Cursor";
        items.push({
          id: `claude-extension-${launcher}`,
          level: "required",
          title: `Claude Code extension missing in ${editorName}`,
          detail: `Approved tickets open Claude in ${editorName}'s chat panel, which needs the Claude Code extension. Install it, or set Settings → Launch → "Claude in VS Code/Cursor" to Terminal.`,
          link: { href: launcher === "vscode" ? "vscode:extension/anthropic.claude-code" : "cursor:extension/anthropic.claude-code", label: `Install in ${editorName}` },
        });
      }
    }

    // Claude's extension is off in Restricted Mode; trusting the worktrees folder once covers every ticket.
    if ((launcher === "vscode" || launcher === "cursor") && this.cfg.launch.ideSession === "chat" && !editorTrusts(launcher, this.cfg.launch.worktreesDir)) {
      const editorName = launcher === "vscode" ? "VS Code" : "Cursor";
      items.push({
        id: `trust-${launcher}`,
        level: "optional",
        title: `Trust your worktrees folder in ${editorName} once`,
        detail: `${editorName} opens untrusted folders in Restricted Mode, where Claude's extension is off and the prompt can't arrive. Open the folder below, then in ${editorName} click "Manage" in the Restricted Mode bar (or "Restricted Mode" in the status bar) → Trust. If it asks "Do you trust the authors?" instead, click Yes. Every ticket's worktree inside is then covered. A ticket that already opened restricted: trust it, then click "Send prompt to chat" on its card.`,
        command: this.cfg.launch.worktreesDir,
        action: { path: `/actions/trust-folder`, label: `Open in ${editorName} to trust it`, busy: "Opening…" },
      });
    }

    if (repoSources(this.cfg).length === 0) {
      items.push({ id: "repos-empty", level: "required", title: "No repos found", detail: "None of the folders in Settings → Repos contains a git repo, so tickets can't be routed." });
    }

    if (!Bun.which("gh", { PATH: process.env.PATH })) {
      items.push({
        id: "gh-install",
        level: "required",
        title: "Install the GitHub CLI",
        detail: "Commits and pull requests (open, draft, merged) are tracked with gh, so it's required.",
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
          level: "required",
          title: user ? `GitHub CLI isn't logged in as ${user}` : "Log in to the GitHub CLI to track pull requests",
          detail: "PR status on launched tickets comes from gh. Log in with an account that can see your repos" +
            (user ? ` (githubUser in config.json is "${user}").` : "."),
          command: user ? `gh auth login  # as ${user}` : "gh auth login",
        });
      }
    }

    if (!isDesktop() && !Bun.which("terminal-notifier", { PATH: process.env.PATH }) && !existsSync("/opt/homebrew/bin/terminal-notifier") && !existsSync("/usr/local/bin/terminal-notifier")) {
      items.push({
        id: "notifier-install",
        level: "optional",
        title: "Clickable notifications",
        detail: "With terminal-notifier, clicking a new-ticket notification opens it here. Without it, notifications are plain.",
        command: "brew install terminal-notifier",
      });
    } else if (!isDesktop() && notifyState.permissionDenied) {
      items.push({
        id: "notifier-permission",
        level: "optional",
        title: "Notifications are blocked for terminal-notifier",
        detail: "Run this once and click Allow, or enable it in System Settings → Notifications → terminal-notifier.",
        command: "terminal-notifier -title autopilot -message test",
      });
    }

    if (!isDesktop()) items.push({
      id: "native-app",
      level: "optional",
      title: app("Autopilot") ? "Open the native macOS app" : "Optional native macOS app",
      detail: "Use Autopilot in its own window with a menu bar icon and Dock badge. Keep your formula and background service running; the app connects to it, and quitting the app leaves it running. This beta is not notarized: after trying to open it, approve it in System Settings → Privacy & Security → Open Anyway.",
      command: app("Autopilot") ? "open -a Autopilot" : "brew install --cask mrinalraj/tap/autopilot",
      link: { href: "https://support.apple.com/en-us/102445", label: "macOS first-launch instructions" },
      browserOnly: true,
    }, {
      id: "install-app",
      level: "optional",
      title: "Add a browser shortcut",
      detail: "Get its own window and a Dock badge with the number of tickets waiting. Chrome: the install icon in the address bar. Safari: File → Add to Dock. Use localhost, not 127.0.0.1.",
      browserOnly: true,
    });

    this.items = items;
    return items;
  }
}

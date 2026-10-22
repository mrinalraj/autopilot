import { mkdirSync } from "node:fs";
import { loadConfig } from "../../config/config";
import { addPicked, checkRepos, patchConfig, resetSettingsFile, saveSettings, saveTracker, writeRepos, writeStatuses } from "../../config/settings";
import { chooseFolders } from "../../platform/folders";
import { runInTerminal } from "../../workspaces/launch";
import { openTracker } from "../../trackers/connect";
import { resetTickets } from "../../app/reset";
import { managedByLaunchd } from "../../updates/update";
import { desktopEvent, isDesktop } from "../../platform/desktop";
import { log } from "../../shared/log";
import { redirect, go } from "../http";
import type { WebContext } from "../context";

const triageInput = (form: FormData) => ({
  summary: String(form.get("summary") ?? ""), approach: String(form.get("approach") ?? ""),
  likelyAreas: String(form.get("likelyAreas") ?? ""), size: String(form.get("size") ?? ""),
  expected: String(form.get("expected") ?? ""),
});

/** Mutations enter here only after the server verifies the request origin and CSRF token. */
export async function handleAction(path: string, form: FormData, ctx: WebContext): Promise<Response> {
  const { ap, updater, health, reschedule, configPath, gh } = ctx;
  if (path === "/poll") {
    void ap.pollIfReady().then(() => ap.refreshWork());
    void health?.refresh();
    return redirect("/");
  }
  const dismiss = path.match(/^\/banners\/([a-z-]+)\/dismiss$/);
  if (dismiss) {
    if (health?.items.some((i) => i.id === dismiss[1] && i.level !== "required")) ap.store.dismissBanner(dismiss[1]);
    return redirect("/");
  }
  if (path === "/banners/restore") {
    ap.store.restoreBanners();
    return redirect("/");
  }
  if (path === "/settings") {
    const githubBefore = ap.cfg.githubUser;
    const launcherBefore = ap.cfg.launch.launcher;
    if (form.get("launcher") !== launcherBefore && ap.launcherBusy) {
      return go("/settings", "error", "A ticket action is still running. Save the launcher change after it finishes.");
    }
    const res = saveSettings(ap.cfg, form, configPath);
    if (res.errors.length) return redirect(`/settings?error=${encodeURIComponent(res.errors.join(" "))}`);
    if (ap.cfg.launch.launcher !== launcherBefore) {
      ap.reconfigureLaunchers();
      res.notes.push("Existing worktrees are being configured for the selected launcher. Failed setup retries automatically; completed setup is remembered.");
    }
    if (ap.cfg.githubUser !== githubBefore) {
      void ap.refreshWork(); // notices the new account and re-checks every ticket
      res.notes.push("Re-checking every ticket's PRs with the new GitHub account.");
    }
    reschedule?.();
    void health?.refresh();
    return redirect(`/settings?notice=${encodeURIComponent(["Saved.", ...res.notes].join(" "))}`);
  }
  if (path === "/actions/reset") {
    try {
      const r = await resetTickets();
      void ap.pollIfReady(); // triage the re-queued tickets right away
      return redirect(`/?notice=${encodeURIComponent(`Reset: cleared ${r.cleared.length}, kept ${r.kept.length} launched, triaging ${r.queued.length}.`)}`);
    } catch (err) {
      return redirect(`/settings?error=${encodeURIComponent(`Reset failed: ${(err as Error).message}`)}`);
    }
  }
  if (path === "/actions/erase") {
    if (form.get("confirm") !== "on") return redirect(`/settings?error=${encodeURIComponent('Tick "Yes, erase everything" to confirm.')}`);
    const resetSettings = form.get("resetSettings") === "on";
    const res = await ap.eraseAll(resetSettings ? () => {
      resetSettingsFile(configPath);
      Object.assign(ap.cfg, loadConfig(configPath));
    } : undefined);
    if (!res.ok) return redirect(`/settings?error=${encodeURIComponent(`Not erased: ${res.error}`)}`);
    ap.store.restoreBanners();
    reschedule?.();
    void health?.refresh();
    if (!ap.cfg.onboarded) return go("/setup", "notice", "Erased all data and reset settings; you're still signed in. Set things up again:");
    void ap.pollIfReady();
    return go("/", "notice", `Erased all data; still signed in. Checking ${ap.trackerLabel} for your tickets now.`);
  }
  if (path === "/actions/signin") {
    const res = ap.startSignIn();
    return redirect(
      res.ok
        ? `/settings?notice=${encodeURIComponent(`${ap.trackerLabel} opened in your browser: approve access there, and this page updates once you're signed in.`)}`
        : `/settings?error=${encodeURIComponent(res.error)}`,
    );
  }
  if (path === "/actions/signout") {
    await ap.signOut();
    return redirect(`/settings?notice=${encodeURIComponent(`Signed out of ${ap.trackerLabel}.`)}`);
  }
  if (path === "/actions/switch-tracker") {
    // Also the "Connect" buttons on the home page and in setup, which add signin=1.
    const from = String(form.get("from") ?? "");
    const back = from === "home" ? "/" : from === "setup" ? "/setup?step=tracker" : "/settings";
    const res = saveTracker(form, configPath);
    if (!res.ok) return go(back, "error", res.error);
    const site = form.has("jiraSite") ? String(form.get("jiraSite")).trim() : ap.cfg.jira.site;
    if (res.tracker !== ap.cfg.tracker || site !== ap.cfg.jira.site) {
      Object.assign(ap.cfg, loadConfig(configPath));
      const sw = await ap.switchTracker(() => openTracker(ap.cfg).tracker);
      if (!sw.ok) return go(back, "error", sw.error);
      health?.refresh().catch(() => {});
    }
    if (form.get("signin")) {
      const si = ap.startSignIn();
      if (!si.ok) return go(back, "error", si.error);
      return go(back, "notice", `${ap.trackerLabel} opened in your browser: approve access there, and this page updates once you're signed in.`);
    }
    void ap.pollIfReady();
    return go(back, "notice", `Now using ${ap.trackerLabel}.`);
  }
  if (path === "/actions/pick-folders") {
    const back = form.get("from") === "setup" ? "/setup?step=repos" : "/settings";
    try {
      const picked = await chooseFolders();
      if (!picked?.length) return redirect(back);
      const errors = addPicked(ap.cfg, picked, configPath);
      if (errors.length) return go(back, "error", errors.join(" "));
      void health?.refresh();
      return go(back, "notice", `Added ${picked.map((p) => p.replace(/\/$/, "").split("/").pop()).join(", ")}.`);
    } catch (err) {
      return go(back, "error", `Couldn't open the folder picker (${(err as Error).message}); type the paths instead.`);
    }
  }
  if (path === "/actions/setup-again") {
    patchConfig(ap.cfg, (raw) => (raw.onboarded = false), configPath);
    return redirect("/setup");
  }
  if (path === "/setup/repos") {
    const lines = (name: string) => String(form.get(name) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const roots = [...new Set([...form.getAll("root").map(String), ...lines("moreRoots")])];
    const paths = lines("repoPaths");
    const errors = checkRepos(roots, paths);
    if (errors.length) return go("/setup?step=repos", "error", errors.join(" "));
    patchConfig(ap.cfg, (raw) => writeRepos(raw, roots, paths), configPath);
    void health?.refresh();
    return redirect("/setup?step=github");
  }
  if (path === "/setup/gh-terminal") {
    const cmd = form.get("cmd") === "install" ? "brew install gh && gh auth login" : "gh auth login";
    try {
      await runInTerminal(ap.cfg, cmd);
    } catch (err) {
      return go("/setup?step=github", "error", `Couldn't open a terminal (${(err as Error).message}). Run \`${cmd}\` yourself, then click Check again.`);
    }
    return go("/setup?step=github", "notice", "Finish in the Terminal window that just opened, then click Check again.");
  }
  if (path === "/setup/github") {
    const user = String(form.get("githubUser") ?? "");
    if (!gh().accounts.some((a) => a.name === user)) return go("/setup?step=github", "error", "Pick one of your gh accounts.");
    const changed = user !== ap.cfg.githubUser;
    patchConfig(ap.cfg, (raw) => (raw.githubUser = user), configPath);
    if (changed && ap.cfg.onboarded) void ap.refreshWork();
    return redirect("/setup?step=tracker");
  }
  if (path === "/setup/statuses") {
    patchConfig(ap.cfg, (raw) => writeStatuses(raw, ap.cfg, form), configPath);
    return redirect("/setup?step=start");
  }
  if (path === "/setup/finish") {
    patchConfig(ap.cfg, (raw) => (raw.onboarded = true), configPath);
    log.info("setup finished; polling starts");
    reschedule?.();
    void health?.refresh();
    void ap.pollIfReady().then(() => ap.refreshWork());
    return go("/", "notice", `Autopilot is running: checking ${ap.trackerLabel} for your tickets now.`);
  }
  if (path === "/actions/trust-folder") {
    // Opening the folder makes the editor ask "Do you trust the authors?"; the choice stays with the user.
    const editorApp = ap.cfg.launch.launcher === "cursor" ? "Cursor" : "Visual Studio Code";
    mkdirSync(ap.cfg.launch.worktreesDir, { recursive: true });
    const r = Bun.spawnSync(["open", "-a", editorApp, ap.cfg.launch.worktreesDir], { stderr: "pipe" });
    if (r.exitCode !== 0) return redirect(`/?error=${encodeURIComponent(`Couldn't open ${editorApp}: ${r.stderr.toString().trim()}`)}`);
    log.info(`opened ${ap.cfg.launch.worktreesDir} in ${editorApp} so it can be trusted`);
    setTimeout(() => void health?.refresh(), 30_000); // hide the tip once trusted
    return redirect(`/?notice=${encodeURIComponent(`Opened ${ap.cfg.launch.worktreesDir} in ${editorApp}. There, click "Manage" in the Restricted Mode bar (or "Restricted Mode" in the status bar) → Trust.`)}`);
  }
  if (path === "/actions/recheck") {
    await health?.refresh();
    return redirect("/settings?notice=" + encodeURIComponent("Setup checks refreshed."));
  }
  if (path === "/actions/check-updates") {
    const info = await updater?.check();
    const msg = !info ? "No releases published yet." : info.available ? `Update available: ${info.latest}.` : `Up to date (${info.current}).`;
    return redirect(`/settings?notice=${encodeURIComponent(msg)}`);
  }
  if (path === "/actions/restart") {
    if (!isDesktop() && !managedByLaunchd()) return redirect(`/settings?error=${encodeURIComponent("Not running as a service; restart it where you started it.")}`);
    desktopEvent({ type: "restarting" });
    setTimeout(() => process.exit(0), 300); // the native host or launchd starts it again
    return redirect("/");
  }
  if (path === "/update") {
    const res = updater ? updater.install() : { ok: false as const, error: "updates are not available here" };
    return redirect(res.ok ? "/" : `/?error=${encodeURIComponent(`Update: ${res.error}`)}`);
  }
  const resend = path.match(/^\/issues\/([^/]+)\/resend-prompt$/);
  if (resend) {
    const identifier = decodeURIComponent(resend[1]);
    const res = ap.resendPrompt(identifier);
    return go("/", res.ok ? "notice" : "error", res.ok ? `Sending ${identifier}'s prompt in the background.` : `${identifier}: ${res.error}`);
  }
  const editTriage = path.match(/^\/issues\/([^/]+)\/edit-triage$/);
  if (editTriage) {
    const identifier = decodeURIComponent(editTriage[1]);
    const res = ap.saveTriage(identifier, triageInput(form));
    const location = `/?${res.ok ? "notice" : "error"}=${encodeURIComponent(res.ok ? res.message : res.error)}#m-${encodeURIComponent(identifier)}`;
    if (form.get("response") === "json") return Response.json({ ...res, location }, { status: res.ok ? 200 : 400 });
    return redirect(location);
  }
  const triage = path.match(/^\/issues\/([^/]+)\/triage$/);
  if (triage) {
    const identifier = decodeURIComponent(triage[1]);
    const res = ap.startTriage(identifier);
    return redirect(res.ok
      ? `/?logs=1&notice=${encodeURIComponent(`Triaging ${identifier} in the background; you can close this.`)}`
      : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`);
  }
  const back = path.match(/^\/issues\/([^/]+)\/send-back$/);
  if (back) {
    const identifier = decodeURIComponent(back[1]);
    const force = form.get("force") === "1";
    const res = ap.runInBackground(identifier, "Sending back to approval…", () => ap.sendBackToApproval(identifier, force));
    return redirect(
      res.ok
        ? `/?logs=1&notice=${encodeURIComponent(`Sending ${identifier} back to approval in the background; you can close this.`)}`
        : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`,
    );
  }
  const del = path.match(/^\/issues\/([^/]+)\/delete-worktrees$/);
  if (del) {
    const identifier = decodeURIComponent(del[1]);
    const force = form.get("force") === "1";
    const res = ap.runInBackground(identifier, "Deleting worktrees…", () => ap.deleteWorktrees(identifier, force));
    return redirect(
      res.ok
        ? `/?logs=1&notice=${encodeURIComponent(`Deleting ${identifier}'s worktrees in the background; you can close this.`)}`
        : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`,
    );
  }
  const m = path.match(/^\/issues\/([^/]+)\/(approve|reject)$/);
  if (m) {
    const identifier = decodeURIComponent(m[1]);
    const res =
      m[2] === "approve"
        ? ap.approve(identifier, String(form.get("repo") ?? ""), String(form.get("branch") ?? ""), form.getAll("extra").map(String), form.has("expected") ? triageInput(form) : undefined)
        : ap.reject(identifier);
    const location = res.ok
      ? m[2] === "approve" ? "/?logs=1" : "/"
      : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}#m-${encodeURIComponent(identifier)}`;
    if (form.get("response") === "json") return Response.json({ ...res, location }, { status: res.ok ? 200 : 400 });
    return redirect(location); // show the log while it launches
  }
  return new Response("not found", { status: 404 });
}

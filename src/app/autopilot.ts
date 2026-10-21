import { workOf, worktreesOf, explainerOf, ticketOf } from "../domain/issues";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, HOME_DIR, type Config } from "../config/config";
import { MAX_ATTEMPTS, Store, type ExtraRepo, type IssueRow } from "../storage/db";
import { CLOSED_STATE_TYPES, LoginRequiredError, type Tracker, type TrackerIssue } from "../trackers/tracker";
import type { LLM } from "../triage/llm";
import { loadCatalog, type RepoEntry } from "../repos/catalog";
import { explain, resolveRepo } from "../triage/triage";
import { briefPath, initPrompt, removeBrief, snapshot, writeBrief } from "../triage/brief";
import { isValidBranch, normalizeBranch } from "../triage/branch";
import { launcherFor, pathFromId, resendIdePrompt, supacodeId, supacodeWorktreePaths } from "../workspaces/launch";
import { scanWorktrees, type FoundWorktree } from "../repos/importer";
import { browserLogin, signOut } from "./login";
import { launchSteps, step, withTicket } from "./steps";
import { notify } from "../platform/notify";
import { atRisk, checkWork, githubAccount, isSettled, workFingerprint, type RepoWork } from "../workspaces/work";
import { log } from "../shared/log";

export const CURSOR_KEY = "poll_cursor";
/** GitHub account the last work check ran as; a different one re-checks settled tickets too. */
const GITHUB_KEY = "github_account";
/** Re-read a window before the cursor to absorb clock skew between us and the tracker. */
const CURSOR_OVERLAP_MS = 5 * 60_000;

export { phaseOf, type Phase } from "../domain/issues";

/** Assigned to me, open, and in one of the configured pickup states. */
export function isEligible(cfg: Config, assigneeId: string | null, stateName: string, stateType: string, me: string): boolean {
  if (assigneeId !== me || CLOSED_STATE_TYPES.has(stateType)) return false;
  const states = cfg.pickupStates.map((s) => s.toLowerCase());
  return states.length === 0 || states.includes(stateName.toLowerCase());
}

export class Autopilot {
  private me: string | null = null;
  polling = false;
  /** Progress of the current triage batch, for the approval page. */
  progress: { current: string | null; done: number; total: number } = { current: null, done: 0, total: 0 };
  lastPollAt: string | null = null;
  lastPollError: string | null = null;

  constructor(
    readonly cfg: Config,
    public store: Store,
    private tracker: Tracker,
    private readonly llm: LLM,
  ) {
    this.recoverLaunches();
  }

  /** A launch can't survive a restart; surface it so it can be retried. */
  private recoverLaunches() {
    for (const row of this.store.listByStatus(["approved"])) {
      this.store.updateIssue(row.linear_id, { status: "failed", error: "daemon restarted during launch; approve again to retry" });
    }
  }

  /** Set by eraseAll: the next first run triages what's already eligible, since that's what the user wants back. */
  private queueExistingOnce = false;
  private queueExisting = () => this.cfg.processExistingOnFirstRun || this.queueExistingOnce;

  /**
   * Erases every ticket (launched and imported too), brief, cache and dismissed tip, for every
   * tracker; sign-ins (Keychain) and config.json stay. Deletes only files the app itself writes,
   * never worktrees. The next poll is a first run that triages what's eligible now.
   */
  async eraseAll(beforeReopen?: () => void): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.polling || this.checkingWork || launchSteps.size || this.signingIn) {
      return { ok: false, error: "busy with a check, launch or sign-in; try again in a moment" };
    }
    this.store.db.close();
    const stateDirs = new Set([this.cfg.stateDir, join(HOME_DIR, "state"), join(HOME_DIR, "state", "jira")]);
    for (const dir of stateDirs) {
      for (const f of ["autopilot.sqlite", "autopilot.sqlite-wal", "autopilot.sqlite-shm", "catalog.cache.json"]) rmSync(join(dir, f), { force: true });
      for (const d of ["briefs", "workspaces"]) rmSync(join(dir, d), { recursive: true, force: true });
    }
    beforeReopen?.(); // e.g. settings reset, which may move stateDir/briefsDir back to the defaults
    // A custom briefsDir may hold other files: remove only briefs.
    if (existsSync(this.cfg.briefsDir)) {
      for (const f of readdirSync(this.cfg.briefsDir)) if (f.endsWith(".md")) rmSync(join(this.cfg.briefsDir, f), { force: true });
    }
    mkdirSync(this.cfg.briefsDir, { recursive: true });
    this.store = new Store(this.cfg.stateDir);
    this.statusCache = null;
    this.lastPollAt = null;
    this.lastPollError = null;
    this.notes.clear();
    this.queueExistingOnce = true;
    log.info("erased all tickets and local data (sign-ins and settings kept)");
    return { ok: true };
  }

  /** True before this tracker has ever produced a ticket (a fresh install, or a tracker never used). */
  isEmpty(): boolean {
    return this.store.listByStatus(["pending", "approved", "running", "failed", "rejected"], 1).length === 0;
  }

  /**
   * Moves to the tracker now in `cfg` (already reloaded): its own store, briefs and sign-in. Refused
   * mid-check or mid-launch, which still belong to the old one.
   */
  async switchTracker(open: () => Tracker): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.polling || this.checkingWork || launchSteps.size || this.signingIn) {
      return { ok: false, error: "busy with a check, launch or sign-in; try again in a moment" };
    }
    const next = open();
    await this.tracker.close();
    this.store.db.close();
    mkdirSync(this.cfg.briefsDir, { recursive: true });
    this.tracker = next;
    this.store = new Store(this.cfg.stateDir);
    this.recoverLaunches();
    this.me = null;
    this.statusCache = null;
    this.lastPollAt = null;
    this.lastPollError = null;
    this.notes.clear();
    log.info(`now watching ${this.trackerLabel}`);
    return { ok: true };
  }

  /** "Linear" or "Jira", for messages and the page. */
  get trackerLabel(): string {
    return this.tracker.label ?? "Linear";
  }

  catalog(): RepoEntry[] {
    return loadCatalog(this.cfg);
  }

  private async userId(): Promise<string> {
    this.me ??= (this.cfg.tracker === "linear" && this.cfg.linearUserId) || (await this.tracker.viewer()).id;
    return this.me;
  }

  private eligible(assigneeId: string | null, stateName: string, stateType: string, me: string): boolean {
    return isEligible(this.cfg, assigneeId, stateName, stateType, me);
  }

  /** Drops a pending item whose ticket stopped being eligible (moved on, or reassigned). */
  private dismissIfPending(linearId: string, reason: string) {
    const row = this.store.getIssue(linearId);
    if (!row || !this.store.transition(linearId, ["pending"], "rejected")) return;
    this.store.updateIssue(linearId, { error: `Dismissed: ${reason}` });
    removeBrief(row.brief_path);
    log.info(`${row.identifier} dismissed: ${reason}`);
  }

  private checkingWork = false;

  /** What the daemon is doing right now, for the page's activity banner (triage has its own). */
  activity(): string | null {
    const job = [...launchSteps.entries()][0];
    if (job) return `${job[0]}: ${job[1]}`;
    if (this.polling) return `Checking ${this.trackerLabel} for new tickets…`;
    if (this.checkingWork) return "Refreshing commits and PR status…";
    return null;
  }

  /** Re-reads commits and PR state for every unsettled launched item, or just `only` (settled or not). */
  async refreshWork(only?: string): Promise<void> {
    if (this.checkingWork && !only) return;
    if (!only) this.checkingWork = true;
    const started = Date.now();
    if (!only) log.info("Refreshing commits and PR status…");
    try {
      // The previous account may not have seen some PRs (or saw ones this one can't), so start over.
      const account = only ? null : await githubAccount(this.cfg.githubUser);
      const previous = this.store.getMeta(GITHUB_KEY);
      const everything = account !== null && previous !== null && account !== previous;
      if (everything) log.info(`GitHub account is now ${account || "(none)"}; re-checking every ticket's commits and PRs`);
      const rows = only ? [this.store.getIssue(only)].filter((r): r is IssueRow => !!r) : this.store.listByStatus(["running"], 200);
      for (const row of rows) {
        if (!row.worktree_id) {
          await this.refreshLinearState(row); // imported without a worktree: tracker status only
          continue;
        }
        const prev = Autopilot.work(row);
        if (isSettled(prev) && !only && !everything) continue;
        try {
          const repos = [
            { repo: row.repo, repoPath: row.repo_path, worktreeId: row.worktree_id },
            ...Store.extras(row).flatMap((e) => (e.worktree_id ? [{ repo: e.repo, repoPath: e.repo_path, worktreeId: e.worktree_id }] : [])),
          ];
          const work: RepoWork[] = [];
          for (const r of repos) work.push({ repo: r.repo, ...(await checkWork(r.worktreeId, r.repoPath, row.branch, this.cfg.githubUser)) });
          await this.refreshLinearState(row);
          const changed = !prev || workFingerprint(prev) !== workFingerprint(work);
          this.store.setWork(row.linear_id, JSON.stringify(work), changed);
          for (const w of work) {
            const before = prev?.find((p) => p.repo === w.repo)?.pr?.state;
            if (w.pr && w.pr.state !== before) log.info(`${row.identifier} ${w.repo} PR #${w.pr.number} is ${w.pr.state.toLowerCase()}`);
          }
        } catch (err) {
          log.warn(`work check failed for ${row.identifier}`, err);
        }
      }
      if (account !== null) this.store.setMeta(GITHUB_KEY, account);
      if (!only) log.info(`Commits and PR status refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } finally {
      if (!only) this.checkingWork = false;
    }
  }

  /** Per-repo work, primary first. Rows checked before multi-repo support stored a single object. */
  private statusCache: { at: number; options: { team: string; name: string; type: string }[] } | null = null;

  /** My teams' (Jira: projects') keys, the default ticket prefixes; empty if the tracker is unreachable. */
  async teamKeys(): Promise<string[]> {
    try {
      return (await this.tracker.me()).teams.map((t) => t.key);
    } catch {
      return [];
    }
  }

  /** Workflow statuses for the settings pickers (cached 10 minutes; empty if the tracker is unreachable). */
  async statusOptions(): Promise<{ team: string; name: string; type: string }[]> {
    if (!this.statusCache || Date.now() - this.statusCache.at > 600_000) {
      try {
        this.statusCache = { at: Date.now(), options: await this.tracker.teamStatuses() };
      } catch (err) {
        log.warn(`could not load ${this.trackerLabel} statuses`, err);
        return this.statusCache?.options ?? [];
      }
    }
    return this.statusCache.options;
  }

  /** Keeps a tracked ticket's tracker status current (it drives the In review / Completed grouping). */
  private async refreshLinearState(row: IssueRow) {
    try {
      const s = await this.tracker.issueState(row.linear_id);
      if (s && (s.name !== row.linear_state || s.type !== row.linear_state_type)) {
        this.store.updateIssue(row.linear_id, { linear_state: s.name, linear_state_type: s.type });
      }
    } catch (err) {
      log.warn(`could not refresh ${this.trackerLabel} status for ${row.identifier}`, err);
    }
  }

  /**
   * Brings in work that didn't start here: my tickets in `importStates` (e.g. In Development) and
   * any worktree whose branch names a ticket. Imported tickets skip triage (no LLM call) and are
   * tracked like launched ones. Tickets that already have a row are left alone.
   */
  async importExisting(): Promise<string[]> {
    const me = await this.tracker.me();
    const prefixes = this.cfg.ticketPrefixes.length ? this.cfg.ticketPrefixes : me.teams.map((t) => t.key);
    const found = this.cfg.importWorktrees ? await scanWorktrees(this.catalog(), prefixes) : new Map<string, FoundWorktree[]>();
    const wanted = new Set(found.keys());
    if (this.cfg.importStates.length) for (const r of await this.tracker.mineInStates(this.cfg.importStates)) wanted.add(r.identifier);

    const supacodePaths = await supacodeWorktreePaths(this.cfg);
    const imported: string[] = [];
    // Awaiting approval (or failed) here, but already started elsewhere: track the existing worktrees instead.
    for (const [identifier, wts] of found) {
      const row = this.store.getIssueByIdentifier(identifier);
      if (!row || !["pending", "failed"].includes(row.status)) continue;
      const [primary, ...others] = wts;
      this.store.updateIssue(row.linear_id, {
        status: "running",
        error: null,
        repo: primary.repo,
        repo_path: primary.repoPath,
        branch: primary.branch,
        worktree_id: supacodeId(primary.path),
        extra_repos_json: JSON.stringify(others.map((w): ExtraRepo => ({ repo: w.repo, repo_path: w.repoPath, reason: "", worktree_id: supacodeId(w.path) }))),
        launcher: supacodePaths.has(primary.path) ? "supacode" : "git",
      });
      this.store.markHandled(row.linear_id);
      writeBrief(this.store.getIssue(row.linear_id)!);
      log.info(`${identifier} already has a worktree (${primary.branch}); moved to In progress instead of awaiting approval`);
      imported.push(identifier);
      await this.refreshWork(row.linear_id);
    }
    for (const identifier of wanted) {
      if (this.store.getIssueByIdentifier(identifier)) continue;
      const issue = await this.tracker.issue(identifier);
      if (!issue || this.store.getIssue(issue.id)) continue;
      const wts = found.get(identifier) ?? [];
      const [primary, ...others] = wts;
      const snapshotJson = JSON.stringify(snapshot(issue, this.trackerLabel));
      const summary = (issue.description ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
      this.store.upsertIssue({
        linear_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        brief_path: briefPath(this.cfg.briefsDir, issue.identifier),
        repo: primary?.repo ?? "",
        repo_path: primary?.repoPath ?? "",
        branch: primary?.branch ?? issue.gitBranchName ?? issue.identifier.toLowerCase(),
        confidence: 1,
        resolve_reason: wts.length ? `Imported from existing worktree${wts.length > 1 ? "s" : ""}` : `Imported from ${this.trackerLabel} (${issue.state.name}); no worktree found`,
        status: "running",
        error: null,
        worktree_id: primary ? supacodeId(primary.path) : null,
        ticket_json: snapshotJson,
        explainer_json: JSON.stringify({ summary: summary || "Imported ticket.", approach: "", likely_areas: [], size: "" }),
        extra_repos_json: JSON.stringify(
          others.map((w): ExtraRepo => ({ repo: w.repo, repo_path: w.repoPath, reason: "", worktree_id: supacodeId(w.path) })),
        ),
      });
      this.store.updateIssue(issue.id, {
        launcher: primary && supacodePaths.has(primary.path) ? "supacode" : "git",
        linear_state: issue.state.name,
        linear_state_type: issue.state.type,
      });
      this.store.markAssigned(issue.id, issue.identifier, true); // never triage an imported ticket
      writeBrief(this.store.getIssue(issue.id)!);
      imported.push(issue.identifier);
      await this.refreshWork(issue.id);
    }
    if (imported.length) log.info(`imported ${imported.length} existing ticket${imported.length === 1 ? "" : "s"}: ${imported.join(", ")}`);
    return imported;
  }

  static work = workOf;

  /** A poll, unless first-run setup isn't finished (nothing is checked or triaged before that). */
  pollIfReady(): Promise<void> {
    return this.cfg.onboarded ? this.poll() : Promise.resolve();
  }

  /** One poll cycle: detect newly eligible tickets, then triage anything not yet handled. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const started = Date.now();
    try {
      log.info(`Checking ${this.trackerLabel} for tickets…`);
      await this.detectAssignments();
      const queued = this.store.unhandled().length;
      // Import first: a ticket that already has a worktree is work under way, not one to triage.
      const imported = await this.importExisting().catch((err) => {
        log.warn("import of existing work failed", err);
        return [] as string[];
      });
      await this.processQueue();
      log.info(`${this.trackerLabel} check done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${queued} to triage, ${imported.length} imported`);
      this.lastPollError = null;
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof LoginRequiredError && this.lastPollError !== msg) {
        await notify({ title: `Autopilot: ${this.trackerLabel} login needed`, message: msg, openUrl: baseUrl(this.cfg), group: "login" });
      }
      this.lastPollError = msg;
      log.error("poll failed", err);
    } finally {
      this.lastPollAt = new Date().toISOString();
      this.polling = false;
    }
  }

  private async detectAssignments() {
    const me = await this.userId();
    const startedAt = new Date().toISOString();
    const cursor = this.store.getMeta(CURSOR_KEY);

    if (!cursor) {
      // First run: baseline what's already eligible so the backlog doesn't flood the queue.
      const eligibleIds = new Set<string>();
      for (const ref of await this.tracker.assignedToMe()) {
        if (!this.eligible(ref.assigneeId, ref.stateName, ref.stateType, me)) continue;
        eligibleIds.add(ref.id);
        this.store.markAssigned(ref.id, ref.identifier, !this.queueExisting());
      }
      for (const row of this.store.listByStatus(["pending"])) {
        if (!eligibleIds.has(row.linear_id)) this.dismissIfPending(row.linear_id, `not assigned to me in ${this.pickupLabel()}`);
      }
      const verb = this.queueExisting() ? "queued" : "baselined";
      this.queueExistingOnce = false;
      log.info(`first run: ${verb} ${eligibleIds.size} tickets already assigned to me in ${this.pickupLabel()}`);
      this.store.setMeta(CURSOR_KEY, startedAt);
      return;
    }

    const since = new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString();
    for (const ref of await this.tracker.updatedSince(since)) {
      const seen = this.store.getAssignment(ref.id);
      if (this.eligible(ref.assigneeId, ref.stateName, ref.stateType, me)) {
        if (seen?.assigned) continue;
        this.store.markAssigned(ref.id, ref.identifier, false);
        log.info(`${ref.identifier} is now assigned to me in "${ref.stateName}"`);
      } else if (seen?.assigned) {
        // No longer eligible, so becoming eligible again later counts as new.
        this.store.markUnassigned(ref.id);
        this.dismissIfPending(ref.id, ref.assigneeId === me ? `moved to "${ref.stateName}"` : "reassigned");
      }
    }
    this.store.setMeta(CURSOR_KEY, startedAt);
  }

  private pickupLabel(): string {
    return this.cfg.pickupStates.length ? this.cfg.pickupStates.map((s) => `"${s}"`).join("/") : "any open state";
  }

  private async processQueue() {
    const me = await this.userId();
    const queue = this.store.unhandled();
    this.progress = { current: null, done: 0, total: queue.length };
    for (const pending of queue) {
      this.progress.current = pending.identifier;
      try {
        const issue = await this.tracker.issue(pending.linear_id);
        if (!issue || !this.eligible(issue.assigneeId, issue.state.name, issue.state.type, me)) {
          this.store.markUnassigned(pending.linear_id);
          continue;
        }
        // Only a rejected item is re-proposed on reassignment; anything else is already in flight.
        const existing = this.store.getIssue(issue.id);
        if (existing && existing.status !== "rejected") {
          this.store.markHandled(issue.id);
          continue;
        }
        await this.triage(issue);
        this.store.markHandled(issue.id);
      } catch (err) {
        const msg = (err as Error).message;
        this.store.recordAttemptFailure(pending.linear_id, msg);
        log.error(`triage failed for ${pending.identifier} (attempt ${pending.attempts + 1}/${MAX_ATTEMPTS})`, err);
        if (pending.attempts + 1 >= MAX_ATTEMPTS) {
          await notify({
            title: `${pending.identifier}: triage failed`,
            message: msg,
            openUrl: baseUrl(this.cfg),
            group: pending.identifier,
          });
        }
      } finally {
        this.progress.done++;
      }
    }
    this.progress = { current: null, done: 0, total: 0 };
  }

  private async triage(issue: TrackerIssue) {
    const catalog = this.catalog();
    if (catalog.length === 0) throw new Error("no git repos found in the folders in Settings → Repos");

    const resolution = await resolveRepo(this.llm, issue, catalog);
    const repo = catalog.find((r) => r.name === resolution.repo)!;
    const explainer = await explain(this.llm, issue, repo);
    const approvalUrl = `${baseUrl(this.cfg)}/#m-${encodeURIComponent(issue.identifier)}`;

    this.store.upsertIssue({
      linear_id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      brief_path: briefPath(this.cfg.briefsDir, issue.identifier),
      repo: repo.name,
      repo_path: repo.path,
      branch: resolution.branch,
      confidence: resolution.confidence,
      resolve_reason: resolution.reason,
      status: "pending",
      error: null,
      worktree_id: null,
      ticket_json: JSON.stringify(snapshot(issue, this.trackerLabel)),
      explainer_json: JSON.stringify(explainer),
      extra_repos_json: JSON.stringify(resolution.extra.map((e): ExtraRepo => ({ ...e, worktree_id: null }))),
    });
    writeBrief(this.store.getIssue(issue.id)!);
    const also = resolution.extra.length ? ` + ${resolution.extra.map((e) => e.repo).join(", ")}` : "";
    log.info(`${issue.identifier} → ${repo.name}${also} @ ${resolution.branch} (confidence ${resolution.confidence})`);

    await notify({ title: `${issue.identifier}: ${issue.title}`, message: explainer.summary, openUrl: approvalUrl, group: issue.identifier });
  }

  /** Validates page edits, saves them and rewrites the brief, then launches in the background. */
  approve(identifier: string, repoName: string, branchInput: string, extraNames: string[] = []): { ok: true } | { ok: false; error: string } {
    const row = this.store.getIssueByIdentifier(identifier);
    if (!row) return { ok: false, error: "unknown issue" };
    const catalog = this.catalog();
    const repo = catalog.find((r) => r.name === repoName);
    if (!repo) return { ok: false, error: `unknown repo "${repoName}"` };
    // Keep the model's reason and any worktree already made for repos still selected.
    const previous = Store.extras(row);
    const extras: ExtraRepo[] = [];
    for (const name of new Set(extraNames)) {
      if (name === repo.name) continue;
      const r = catalog.find((c) => c.name === name);
      if (!r) return { ok: false, error: `unknown repo "${name}"` };
      const prev = previous.find((p) => p.repo === name);
      extras.push({ repo: r.name, repo_path: r.path, reason: prev?.reason ?? "", worktree_id: prev?.worktree_id ?? null });
    }
    const branch = normalizeBranch(branchInput.trim(), row.identifier, row.title);
    if (!isValidBranch(branch, row.identifier)) return { ok: false, error: `invalid branch "${branch}"` };

    if (!this.store.transition(row.linear_id, ["pending", "failed"], "approved")) {
      return { ok: false, error: `cannot approve an item in status "${row.status}"` };
    }
    this.store.updateIssue(row.linear_id, { repo: repo.name, repo_path: repo.path, branch, extra_repos_json: JSON.stringify(extras) });
    const updated = this.store.getIssue(row.linear_id)!;
    try {
      writeBrief(updated);
    } catch (err) {
      this.store.updateIssue(row.linear_id, { status: "failed", error: `could not write brief: ${(err as Error).message}` });
      return { ok: false, error: (err as Error).message };
    }

    void this.runLaunch(updated);
    return { ok: true };
  }

  /**
   * Creates a worktree per repo (extras in the background, saved as they're made so a retry reuses
   * them), rewrites the brief with their paths, then starts claude in the primary worktree with
   * the brief dir and the extra worktrees added.
   */
  private async runLaunch(row: IssueRow) {
    return withTicket(row.identifier, () => this.launchSteps(row));
  }

  private async launchSteps(row: IssueRow) {
    try {
      // A retry keeps the launcher that already made some of the worktrees.
      const launcher = launcherFor(this.cfg, row.launcher);
      this.store.updateIssue(row.linear_id, { launcher: launcher.name });
      const extras = Store.extras(row);
      step(`Preparing ${extras.length + 1} worktree${extras.length ? "s" : ""} on ${row.branch}`);
      // Repos are independent, so fetch and create their worktrees in parallel (extras in the background).
      const [primaryPath, ...extraPaths] = await Promise.all([
        launcher.ensureWorktree(row.repo_path, row.branch, this.cfg.launch.background),
        ...extras.map((e) => launcher.ensureWorktree(e.repo_path, row.branch, true)),
      ]);
      extras.forEach((e, i) => (e.worktree_id = supacodeId(extraPaths[i])));
      const others = extras.map((e, i) => ({ repo: e.repo, path: extraPaths[i] }));
      this.store.updateIssue(row.linear_id, { worktree_id: supacodeId(primaryPath), extra_repos_json: JSON.stringify(extras) });
      writeBrief(this.store.getIssue(row.linear_id)!);

      await launcher.openSession({
        identifier: row.identifier,
        briefPath: row.brief_path,
        others,
        primaryPath,
        otherPaths: others.map((o) => o.path),
        prompt: initPrompt(row.brief_path, others),
        addDirs: [this.cfg.briefsDir, ...others.map((o) => o.path)],
        background: this.cfg.launch.background,
      });
      this.store.updateIssue(row.linear_id, { status: "running", error: null });
      step("Launched");
      void this.refreshWork();
      if (this.cfg.moveToInProgressOnApprove) {
        try {
          log.info(`${row.identifier} moved to "${await this.tracker.moveToStarted(row.identifier)}"`);
        } catch (err) {
          log.warn(`could not move ${row.identifier} to In Progress`, err);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`launch failed for ${row.identifier}`, err);
      this.store.updateIssue(row.linear_id, { status: "failed", error: msg });
    }
  }

  /** Worktrees a launched ticket owns: primary first, then the extra repos'. */
  static worktrees = worktreesOf;

  /**
   * Deletes a ticket's worktrees through Supacode. Re-checks each one first and refuses, unless
   * `force`, when any has uncommitted changes or unpushed commits. PR tracking carries on.
   */
  async deleteWorktrees(identifier: string, force: boolean): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const row = this.store.getIssueByIdentifier(identifier);
    if (!row) return { ok: false, error: "unknown issue" };
    const wts = Autopilot.worktrees(row);
    if (!wts.length) return { ok: false, error: "no worktrees to delete" };

    step("Checking the worktrees for unsaved work…");
    const checks = await Promise.all(wts.map(async (w) => ({ ...w, work: await checkWork(w.worktreeId, w.repoPath, row.branch, this.cfg.githubUser) })));
    const live = checks.filter((c) => !c.work.missing);
    if (!live.length) return { ok: false, error: "the worktrees are already gone" };
    const risks = live.flatMap((c) => atRisk(c.work).map((r) => `${c.repo}: ${r}`));
    if (risks.length && !force) return { ok: false, error: `not deleted, it would lose ${risks.join(", ")}; tick "delete anyway" to confirm` };

    const failed: string[] = [];
    const launcher = launcherFor(this.cfg, row.launcher ?? "supacode");
    for (const c of live) {
      try {
        step(`Removing the worktree in ${c.repo}…`);
        await launcher.removeWorktree(c.repoPath, c.work.worktreePath, row.branch, force);
        log.info(`${row.identifier}: deleted worktree ${c.work.worktreePath}`);
      } catch (err) {
        failed.push(`${c.repo}: ${(err as Error).message}`);
      }
    }
    // A deleted worktree with an open PR stays in progress; PR tracking carries on from the main repo.
    await this.refreshWork(row.linear_id);
    if (failed.length) return { ok: false, error: `could not delete: ${failed.join("; ")}` };
    return { ok: true, message: `Deleted ${live.length} worktree${live.length === 1 ? "" : "s"} for ${row.identifier}.` };
  }

  /**
   * Undoes a launch: deletes any of the ticket's worktrees that remain (same safety checks as
   * deleteWorktrees) and puts it back in Awaiting approval with its triage intact. Branches stay.
   */
  /** The outcome of each ticket's last background action, shown on its card until the next one. */
  readonly notes = new Map<string, { level: "error" | "info"; msg: string }>();

  /**
   * Runs a slow ticket action in the background: the request returns at once, the card shows the
   * live step, and the result lands on the card and in the log (closing the page doesn't stop it).
   */
  runInBackground(
    identifier: string,
    label: string,
    action: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>,
  ): { ok: true } | { ok: false; error: string } {
    if (!this.store.getIssueByIdentifier(identifier)) return { ok: false, error: "unknown issue" };
    if (launchSteps.has(identifier)) return { ok: false, error: `already working on it (${launchSteps.get(identifier)})` };
    this.notes.delete(identifier);
    void withTicket(identifier, async () => {
      step(label);
      try {
        const res = await action();
        if (res.ok) {
          log.info(res.message);
          this.notes.set(identifier, { level: "info", msg: res.message });
        } else {
          log.warn(`${identifier}: ${res.error}`);
          this.notes.set(identifier, { level: "error", msg: res.error });
        }
      } catch (err) {
        log.error(`${identifier}: ${label} failed`, err);
        this.notes.set(identifier, { level: "error", msg: (err as Error).message });
      }
    });
    return { ok: true };
  }

  async sendBackToApproval(identifier: string, force: boolean): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const row = this.store.getIssueByIdentifier(identifier);
    if (!row) return { ok: false, error: "unknown issue" };
    if (!["running", "failed"].includes(row.status)) return { ok: false, error: `only launched tickets can be sent back (this one is ${row.status})` };
    if (!row.repo) return { ok: false, error: "this ticket was imported without a repo; there's no triage to go back to" };

    const live = (await Promise.all(Autopilot.worktrees(row).map(async (w) => ({ ...w, work: await checkWork(w.worktreeId, w.repoPath, row.branch) }))))
      .filter((c) => !c.work.missing);
    if (live.length) {
      const res = await this.deleteWorktrees(identifier, force);
      if (!res.ok) return res;
    }
    const fresh = this.store.getIssue(row.linear_id)!;
    const extras = Store.extras(fresh).map((e) => ({ ...e, worktree_id: null }));
    this.store.updateIssue(row.linear_id, { status: "pending", error: null, worktree_id: null, launcher: null, extra_repos_json: JSON.stringify(extras) });
    this.store.db.query("UPDATE issues SET work_json = NULL WHERE linear_id = ?").run(row.linear_id);
    writeBrief(this.store.getIssue(row.linear_id)!);
    log.info(`${identifier} sent back to approval`);
    return { ok: true, message: `${identifier} is back in Awaiting approval${live.length ? ` (removed ${live.length} worktree${live.length === 1 ? "" : "s"})` : ""}.` };
  }

  /** Who's signed in to the tracker, or null when signed out (or the login was revoked). */
  async account(): Promise<{ name: string; email: string | null } | null> {
    try {
      const me = await this.tracker.me();
      return { name: me.name, email: me.email };
    } catch (err) {
      if (err instanceof LoginRequiredError) return null;
      throw err;
    }
  }

  signingIn = false;

  /**
   * Browser sign-in from the page (switches account if one is signed in). Runs in the background;
   * the daemon reconnects with the new credentials and polls when it completes.
   */
  startSignIn(): { ok: true } | { ok: false; error: string } {
    if (this.signingIn) return { ok: false, error: "a sign-in is already waiting in your browser" };
    this.signingIn = true;
    log.info(`Opening ${this.trackerLabel} in your browser to sign in…`);
    void browserLogin(this.cfg, { force: true })
      .then(async (me) => {
        log.info(`Signed in to ${this.trackerLabel} as ${me.name}${me.email ? ` <${me.email}>` : ""}`);
        await this.afterAuthChange();
        void this.pollIfReady();
      })
      .catch((err) => log.warn(`${this.trackerLabel} sign-in didn't complete`, err))
      .finally(() => (this.signingIn = false));
    return { ok: true };
  }

  async signOut() {
    await signOut(this.cfg);
    await this.afterAuthChange();
    this.lastPollError = new LoginRequiredError(this.trackerLabel).message;
    log.info(`Signed out of ${this.trackerLabel}; polling stops until you sign in again`);
  }

  /** Forget everything cached about the previous account. */
  private async afterAuthChange() {
    await this.tracker.resetAuth();
    this.me = null;
    this.statusCache = null;
  }

  /** Sends a VS Code/Cursor ticket's prompt to the editor's chat again (after trusting its folder). */
  async resendPrompt(identifier: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const row = this.store.getIssueByIdentifier(identifier);
    if (!row?.worktree_id || (row.launcher !== "vscode" && row.launcher !== "cursor")) return { ok: false, error: "not a VS Code/Cursor launch" };
    const others = Store.extras(row).flatMap((e) => (e.worktree_id ? [{ repo: e.repo, path: pathFromId(e.worktree_id) }] : []));
    try {
      await resendIdePrompt(this.cfg, row.launcher, {
        identifier: row.identifier,
        briefPath: row.brief_path,
        others,
        primaryPath: pathFromId(row.worktree_id),
        otherPaths: others.map((o) => o.path),
        prompt: "",
        addDirs: [],
        background: false,
      });
      log.info(`${identifier}: sent the prompt to the ${row.launcher === "vscode" ? "VS Code" : "Cursor"} chat again`);
      return { ok: true, message: `Sent ${identifier}'s prompt to the chat; press Enter there to start.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  reject(identifier: string): { ok: true } | { ok: false; error: string } {
    const row = this.store.getIssueByIdentifier(identifier);
    if (!row) return { ok: false, error: "unknown issue" };
    if (!this.store.transition(row.linear_id, ["pending", "failed"], "rejected")) {
      return { ok: false, error: `cannot reject an item in status "${row.status}"` };
    }
    removeBrief(row.brief_path);
    log.info(`${row.identifier} rejected`);
    return { ok: true };
  }

  static explainer = explainerOf;

  static ticket = ticketOf;
}

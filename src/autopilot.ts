import { baseUrl, type Config } from "./config";
import { MAX_ATTEMPTS, Store, type ExtraRepo, type IssueRow } from "./db";
import { CLOSED_STATE_TYPES, LinearClient, LoginRequiredError, type LinearIssue } from "./linear";
import type { LLM } from "./llm";
import { loadCatalog, type RepoEntry } from "./catalog";
import { explain, resolveRepo, type Explainer } from "./triage";
import { briefPath, initPrompt, removeBrief, snapshot, writeBrief, type TicketSnapshot } from "./brief";
import { isValidBranch, normalizeBranch } from "./branch";
import { ensureWorktree, openClaudeTab } from "./launch";
import { notify } from "./notify";
import { checkWork, isSettled, workFingerprint, type RepoWork } from "./work";
import { log } from "./log";

export const CURSOR_KEY = "poll_cursor";
/** Re-read a window before the cursor to absorb clock skew between us and Linear. */
const CURSOR_OVERLAP_MS = 5 * 60_000;

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
    readonly store: Store,
    private readonly linear: LinearClient,
    private readonly llm: LLM,
  ) {
    // A launch can't survive a restart; surface it so it can be retried.
    for (const row of store.listByStatus(["approved"])) {
      store.updateIssue(row.linear_id, { status: "failed", error: "daemon restarted during launch; approve again to retry" });
    }
  }

  catalog(): RepoEntry[] {
    return loadCatalog(this.cfg);
  }

  private async userId(): Promise<string> {
    this.me ??= this.cfg.linearUserId || (await this.linear.viewer()).id;
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

  /** Re-reads commits and PR state for every launched item. */
  async refreshWork(): Promise<void> {
    if (this.checkingWork) return;
    this.checkingWork = true;
    try {
      for (const row of this.store.listByStatus(["running"], 200)) {
        if (!row.worktree_id) continue;
        const prev = Autopilot.work(row);
        if (isSettled(prev)) continue;
        try {
          const repos = [
            { repo: row.repo, repoPath: row.repo_path, worktreeId: row.worktree_id },
            ...Store.extras(row).flatMap((e) => (e.worktree_id ? [{ repo: e.repo, repoPath: e.repo_path, worktreeId: e.worktree_id }] : [])),
          ];
          const work: RepoWork[] = [];
          for (const r of repos) work.push({ repo: r.repo, ...(await checkWork(r.worktreeId, r.repoPath, row.branch)) });
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
    } finally {
      this.checkingWork = false;
    }
  }

  /** Per-repo work, primary first. Rows checked before multi-repo support stored a single object. */
  static work(row: IssueRow): RepoWork[] | null {
    if (!row.work_json) return null;
    const w = JSON.parse(row.work_json);
    return Array.isArray(w) ? w : [{ repo: row.repo, ...w }];
  }

  /** One poll cycle: detect newly eligible tickets, then triage anything not yet handled. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.detectAssignments();
      await this.processQueue();
      this.lastPollError = null;
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof LoginRequiredError && this.lastPollError !== msg) {
        await notify({ title: "Linear autopilot: login needed", message: msg, openUrl: baseUrl(this.cfg), group: "login" });
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
      for (const ref of await this.linear.assignedToMe()) {
        if (!this.eligible(ref.assigneeId, ref.stateName, ref.stateType, me)) continue;
        eligibleIds.add(ref.id);
        this.store.markAssigned(ref.id, ref.identifier, !this.cfg.processExistingOnFirstRun);
      }
      for (const row of this.store.listByStatus(["pending"])) {
        if (!eligibleIds.has(row.linear_id)) this.dismissIfPending(row.linear_id, `not assigned to me in ${this.pickupLabel()}`);
      }
      log.info(`first run: baselined ${eligibleIds.size} tickets already assigned to me in ${this.pickupLabel()}`);
      this.store.setMeta(CURSOR_KEY, startedAt);
      return;
    }

    const since = new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString();
    for (const ref of await this.linear.updatedSince(since)) {
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
        const issue = await this.linear.issue(pending.linear_id);
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

  private async triage(issue: LinearIssue) {
    const catalog = this.catalog();
    if (catalog.length === 0) throw new Error(`no git repos found under ${this.cfg.reposRoot}`);

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
      ticket_json: JSON.stringify(snapshot(issue)),
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
    try {
      const extras = Store.extras(row);
      for (const e of extras) {
        e.worktree_id = await ensureWorktree(this.cfg, e.repo_path, row.branch, true);
        this.store.updateIssue(row.linear_id, { extra_repos_json: JSON.stringify(extras) });
      }
      const worktreeId = await ensureWorktree(this.cfg, row.repo_path, row.branch, this.cfg.launch.background);
      this.store.updateIssue(row.linear_id, { worktree_id: worktreeId });
      writeBrief(this.store.getIssue(row.linear_id)!);

      const others = extras.map((e) => ({ repo: e.repo, path: decodeURIComponent(e.worktree_id!).replace(/\/$/, "") }));
      await openClaudeTab(this.cfg, {
        identifier: row.identifier,
        worktreeId,
        prompt: initPrompt(row.brief_path, others),
        addDirs: [this.cfg.briefsDir, ...others.map((o) => o.path)],
        background: this.cfg.launch.background,
      });
      this.store.updateIssue(row.linear_id, { status: "running", error: null });
      void this.refreshWork();
      if (this.cfg.moveToInProgressOnApprove) {
        try {
          log.info(`${row.identifier} moved to "${await this.linear.moveToStarted(row.identifier)}"`);
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

  static explainer(row: IssueRow): Explainer {
    return JSON.parse(row.explainer_json);
  }

  static ticket(row: IssueRow): TicketSnapshot {
    return JSON.parse(row.ticket_json);
  }
}

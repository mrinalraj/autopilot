import { launchSteps } from "../../app/steps";
import { eventsSince } from "../../shared/log";
import { phaseOf, workOf, worktreesOf } from "../../domain/issues";
import { launcherFor } from "../../workspaces/launch";
import { pathFromId } from "../../domain/worktree";
import { stateVersion } from "../state";
import { csrfField } from "../views/forms";
import type { WebContext } from "../context";
import type { DashboardData } from "../models";

/** Gather state once per request; templates only receive the resulting snapshot. */
export async function dashboardData(ctx: WebContext, error?: string, notice?: string): Promise<DashboardData> {
  const { ap, updater, health } = ctx;
  const queue = ap.store.listByStatus(["pending", "failed"]);
  const launching = ap.store.listByStatus(["approved"]);
  const running = ap.store.listByStatus(["running"], 300);
  const rejected = ap.store.listByStatus(["rejected"], 100);
  const rows = [...queue, ...launching, ...running, ...rejected];
  const inProgress = running.filter((row) => phaseOf(row, workOf(row)) === "in-progress");
  const inReview = running.filter((row) => phaseOf(row, workOf(row)) === "in-review");
  const completed = running.filter((row) => phaseOf(row, workOf(row)) === "completed");
  const prsOpen = [...inProgress, ...inReview].flatMap((row) => workOf(row) ?? []).filter((w) => w.pr?.state === "OPEN").length;
  const launcher = launcherFor(ap.cfg);
  const worktreeLinks = new Map<string, Map<string, string | null>>();
  await Promise.all(rows.map(async (row) => {
    const paths = new Set([
      ...worktreesOf(row).map((w) => pathFromId(w.worktreeId)),
      ...(workOf(row) ?? []).map((w) => w.worktreePath),
    ]);
    const links = await Promise.all([...paths].map(async (path) => {
      return [path, await launcher.link(path)] as const;
    }));
    worktreeLinks.set(row.linear_id, new Map(links));
  }));
  return {
    cfg: structuredClone(ap.cfg), trackerLabel: ap.trackerLabel,
    // An empty dashboard needs no repo choices (nor a filesystem/catalog scan).
    catalog: rows.length ? ap.catalog() : [],
    queue, launching, inProgress, inReview, completed, prsOpen, rejected, worktreeLinks,
    steps: new Map(launchSteps), notes: new Map(ap.notes), canResendPrompt: !!launcher.resendPrompt,
    health: health ? { items: [...health.items] } : undefined,
    dismissed: ap.store.dismissedBanners(),
    updater: updater ? { info: updater.info, status: updater.status, error: updater.error } : undefined,
    logs: eventsSince(0, 150), progress: { ...ap.progress }, activity: ap.activity(),
    lastPollAt: ap.lastPollAt, lastPollError: ap.lastPollError,
    polling: ap.polling, signingIn: ap.signingIn, empty: ap.isEmpty(),
    version: stateVersion(ap, updater), bootId: ctx.bootId, tokenField: csrfField(ctx.csrf), error, notice,
  };
}

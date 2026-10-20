import { rmSync } from "node:fs";
import { loadConfig } from "./config";
import { Store } from "./db";
import { openTracker } from "./connect";
import { CURSOR_KEY, isEligible } from "./autopilot";

/**
 * Clears every ticket that hasn't been launched (pending, failed, rejected or dismissed) with its
 * brief, then queues the tickets eligible right now so the next poll (or "Poll now") triages them
 * afresh. Launched tickets keep their row, brief and PR tracking. Safe while the daemon runs.
 */
export interface ResetSummary {
  cleared: string[];
  kept: string[];
  queued: string[];
}

export async function resetTickets(): Promise<ResetSummary> {
  const cfg = loadConfig();
  const store = new Store(cfg.stateDir);
  const { tracker: linear } = openTracker(cfg);
  try {
    const me = (cfg.tracker === "linear" && cfg.linearUserId) || (await linear.viewer()).id;
    const eligible = (await linear.assignedToMe()).filter((r) => isEligible(cfg, r.assigneeId, r.stateName, r.stateType, me));

    const kept = store.listByStatus(["approved", "running"], 1000);
    const keptIds = new Set(kept.map((r) => r.linear_id));
    const cleared = store.listByStatus(["pending", "failed", "rejected"], 1000);
    const queued = eligible.filter((r) => !keptIds.has(r.id));

    store.db.transaction(() => {
      store.db.exec("DELETE FROM issues WHERE status IN ('pending', 'failed', 'rejected'); DELETE FROM assignments;");
      // Launched tickets stay tracked as handled so they're never proposed again by this reset.
      for (const r of kept) store.markAssigned(r.linear_id, r.identifier, true);
      for (const r of queued) store.markAssigned(r.id, r.identifier, false);
      store.setMeta(CURSOR_KEY, new Date().toISOString());
    })();
    for (const r of cleared) rmSync(r.brief_path, { force: true });
    return { cleared: cleared.map((r) => r.identifier), kept: kept.map((r) => r.identifier), queued: queued.map((r) => r.identifier) };
  } finally {
    await linear.close();
  }
}

/** CLI: reset and print what happened. */
export async function reset() {
  try {
    const r = await resetTickets();
    console.log(`Cleared ${r.cleared.length} unlaunched tickets; kept ${r.kept.length} launched: ${r.kept.join(", ") || "(none)"}`);
    console.log(`Queued ${r.queued.length} for triage: ${r.queued.join(", ") || "(none)"}`);
    console.log('They are triaged on the next poll; click "Poll now" to start right away.');
  } catch (err) {
    console.error(`Reset failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

import type { Autopilot } from "../app/autopilot";
import type { Updater } from "../updates/updater";
import { launchSteps } from "../app/steps";
import type { WebContext } from "./context";

/** Changes whenever the set of tickets or their statuses change. */
export function stateVersion(ap: Autopilot, updater?: Updater): string {
  const v = ap.store.db
    .query<{ n: number; t: string | null }, []>("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM issues")
    .get();
  const notes = [...ap.notes.entries()].map(([k, n]) => `${k}:${n.level}:${n.msg.length}`).join(",");
  const launch = ap.cfg.launch;
  return `${v?.n ?? 0}|${v?.t ?? ""}|${ap.lastPollError ?? ""}|${updater?.status ?? ""}|${updater?.info?.latest ?? ""}|${notes}|${[...launchSteps.keys()].join(",")}|${launch.launcher}:${launch.terminal}:${launch.ideSession}:${launch.cursorChat}`;
}

export function liveState({ ap, updater, bootId }: WebContext) {
  return {
    polling: ap.polling, activity: ap.activity(), progress: { ...ap.progress },
    version: stateVersion(ap, updater), awaiting: ap.store.listByStatus(["pending", "failed"]).length,
    launching: Object.fromEntries(launchSteps), boot: bootId, signingIn: ap.signingIn,
  };
}

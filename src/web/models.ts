import type { Config } from "../config/config";
import type { IssueRow } from "../domain/issues";
import type { RepoEntry } from "../repos/catalog";
import type { SetupItem } from "../app/health";
import type { Updater } from "../updates/updater";
import type { LogEvent } from "../shared/log";

/** Read-only snapshots passed to templates; no services, queries or action callbacks. */
export interface TicketViewData {
  cfg: Pick<Config, "lowConfidenceThreshold" | "launch">;
  trackerLabel: string;
  catalog: readonly RepoEntry[];
  steps: ReadonlyMap<string, string>;
  notes: ReadonlyMap<string, { level: "error" | "info"; msg: string }>;
  worktreeLinks: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  tokenField: string;
  canResendPrompt: boolean;
}

export type UpdateViewData = Pick<Updater, "info" | "status" | "error">;
export interface ProgressViewData {
  progress: { current: string | null; done: number; total: number };
  activity: string | null;
}

export interface DashboardData extends TicketViewData, ProgressViewData {
  cfg: Config;
  queue: IssueRow[];
  launching: IssueRow[];
  inProgress: IssueRow[];
  inReview: IssueRow[];
  completed: IssueRow[];
  prsOpen: number;
  rejected: IssueRow[];
  health?: { items: readonly SetupItem[] };
  dismissed: ReadonlySet<string>;
  updater?: UpdateViewData;
  logs: LogEvent[];
  lastPollAt: string | null;
  lastPollError: string | null;
  polling: boolean;
  signingIn: boolean;
  empty: boolean;
  version: string;
  bootId: string;
  error?: string;
  notice?: string;
}

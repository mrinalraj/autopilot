import type { Config } from "../config/config";

/** The issue trackers the daemon can watch. One is active at a time (`cfg.tracker`). */
export const TRACKER_KINDS = ["linear", "jira"] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

export interface TrackerIssue {
  /** The tracker's stable ID (Linear UUID, Jira numeric ID); stored as `linear_id`. */
  id: string;
  /** Human key, e.g. ENG-123. */
  identifier: string;
  title: string;
  /** Markdown. */
  description: string | null;
  url: string;
  updatedAt: string;
  /** The tracker's suggested branch name, if it has one (Linear does, Jira doesn't). */
  gitBranchName: string | null;
  assigneeId: string | null;
  /** `type` uses Linear's vocabulary (unstarted, started, completed, canceled, …) for every tracker. */
  state: { name: string; type: string };
  /** Linear team, or Jira project. */
  team: { id: string; key: string; name: string };
  project: string | null;
  labels: string[];
  attachments: { title: string; url: string }[];
  comments: { author: string; createdAt: string; body: string }[];
}

/** Minimal row used for assignment tracking. */
export interface IssueRef {
  id: string;
  identifier: string;
  assigneeId: string | null;
  stateName: string;
  stateType: string;
}

export interface Me {
  id: string;
  name: string;
  email: string | null;
  /** Linear teams, or the Jira projects my tickets are in; their keys are the default ticket prefixes. */
  teams: { id: string; name: string; key: string }[];
}

export interface Tracker {
  readonly kind: TrackerKind;
  readonly label: string;
  viewer(): Promise<{ id: string; name: string; email: string | null }>;
  /** The signed-in user and their teams (cached until resetAuth). */
  me(): Promise<Me>;
  /** Every open ticket assigned to me (first-run baseline). */
  assignedToMe(): Promise<IssueRef[]>;
  /** Tickets updated after `since` that are, or were, assigned to me (catches unassignment too). */
  updatedSince(since: string): Promise<IssueRef[]>;
  /** Full ticket by ID or key, with all comments; null when it doesn't exist. */
  issue(idOrKey: string): Promise<TrackerIssue | null>;
  /** My tickets currently in any of `states` (status names). */
  mineInStates(states: string[]): Promise<IssueRef[]>;
  issueState(idOrKey: string): Promise<{ name: string; type: string } | null>;
  /** Workflow statuses for the settings pickers. */
  teamStatuses(): Promise<{ team: string; name: string; type: string }[]>;
  /** Moves the ticket to a started state; returns the new status name. */
  moveToStarted(idOrKey: string): Promise<string>;
  /** Drops the connection and anything cached about the account (after sign-in or sign-out). */
  resetAuth(): Promise<void>;
  close(): Promise<void>;
}

export const CLOSED_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);

export class LoginRequiredError extends Error {
  constructor(label = "Linear") {
    super(`${label} login required: sign in from Settings (or run \`autopilot login\`)`);
  }
}

export interface TrackerSpec {
  kind: TrackerKind;
  label: string;
  mcpUrl: URL;
  /** Keychain account holding this tracker's OAuth client and tokens. */
  keychainAccount: string;
  /** RFC 7009 revocation endpoint, used on sign-out (best effort). */
  revokeUrl: string;
  /** OAuth scope to request; undefined lets the server pick its default. */
  scope(cfg: Config): string | undefined;
}

export const TRACKERS: Record<TrackerKind, TrackerSpec> = {
  linear: {
    kind: "linear",
    label: "Linear",
    mcpUrl: new URL("https://mcp.linear.app/mcp"),
    keychainAccount: "linear-mcp-oauth",
    revokeUrl: "https://mcp.linear.app/token",
    scope: (cfg) => (cfg.moveToInProgressOnApprove ? "read write" : "read"),
  },
  jira: {
    kind: "jira",
    label: "Jira",
    mcpUrl: new URL("https://mcp.atlassian.com/v1/mcp"),
    keychainAccount: "jira-mcp-oauth",
    revokeUrl: "https://mcp.atlassian.com/v1/token",
    scope: () => undefined,
  },
};

export const trackerSpec = (cfg: Pick<Config, "tracker">): TrackerSpec => TRACKERS[cfg.tracker];

import type { Config } from "../config/config";
import type { GithubStatus } from "../platform/github";

export const STEPS = [
  { id: "repos", title: "Repos" },
  { id: "github", title: "GitHub" },
  { id: "tracker", title: "Tracker" },
  { id: "statuses", title: "Statuses" },
  { id: "start", title: "How it works" },
] as const;
export type StepId = (typeof STEPS)[number]["id"];
export const isStep = (s: string | null): s is StepId => STEPS.some((x) => x.id === s);
export const nextStep = (s: StepId): StepId => STEPS[Math.min(STEPS.findIndex((x) => x.id === s) + 1, STEPS.length - 1)].id;

export interface SetupData {
  cfg: Config;
  homeDir: string;
  step: StepId;
  tokenField: string;
  trackerLabel: string;
  account: { name: string; email: string | null } | null;
  signingIn: boolean;
  gh: GithubStatus;
  /** Repos currently in play. */
  repos: { name: string; path: string }[];
  suggestions: { path: string; repos: string[] }[];
  statuses: { team: string; name: string; type: string }[];
  error?: string;
  notice?: string;
}

/** Which steps are complete, so the first visit lands on the first one that isn't. */
export function doneSteps(d: Pick<SetupData, "cfg" | "repos" | "gh" | "account">): Set<StepId> {
  const done = new Set<StepId>();
  if (d.repos.length) done.add("repos");
  if (d.gh.accounts.some((a) => a.name === d.cfg.githubUser)) done.add("github");
  if (d.account) done.add("tracker");
  return done;
}

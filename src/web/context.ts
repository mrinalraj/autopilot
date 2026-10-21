import type { Autopilot } from "../app/autopilot";
import type { Health } from "../app/health";
import type { Updater } from "../updates/updater";
import type { GithubStatus } from "../platform/github";

export interface WebOptions {
  updater?: Updater;
  health?: Health;
  reschedule?: () => void;
  configPath?: string;
  gh?: () => GithubStatus;
}

export interface WebContext extends WebOptions {
  ap: Autopilot;
  configPath: string;
  gh: () => GithubStatus;
  csrf: string;
  bootId: string;
}

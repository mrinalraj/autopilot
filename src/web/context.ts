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
  ghAsync?: () => Promise<GithubStatus>;
}

export interface WebContext extends WebOptions {
  /** Presentation only; this flag grants no permissions. */
  desktopClient?: boolean;
  ap: Autopilot;
  configPath: string;
  gh: () => GithubStatus;
  csrf: string;
  bootId: string;
}

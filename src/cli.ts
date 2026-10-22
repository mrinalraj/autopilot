import { version } from "../package.json";
import { APP_BUNDLE, baseUrl, CONFIG_PATH, HOME_DIR, loadConfig, LOG_PATH } from "./config/config";
import { preparePath } from "./platform/env";

const HELP = `autopilot ${version}
Triage Linear tickets assigned to you and launch Claude Code sessions for the ones you approve.

Usage: autopilot <command>

  start                 Run the daemon and approval page (what the service runs)
  once                  Run one poll + triage pass, then exit
  login [--force]       Log in to Linear in the browser (--force replaces stored credentials)
  reset                 Clear unlaunched tickets and re-queue the eligible ones
  update [--check]      Install the latest release (--check only reports)
  open                  Open the approval page
  service install       Run at login via launchd (and restart on crash)
  service uninstall     Remove the launchd service
  service restart       Restart the running service
  service status        Show whether the service is running
  paths                 Show where config, state and logs live
  version               Print the version
`;

preparePath();
const [cmd = "help", sub, ...rest] = process.argv.slice(2);
const flags = new Set([sub, ...rest].filter(Boolean));

try {
  switch (cmd) {
    case "start":
      if (APP_BUNDLE) throw new Error("Open Autopilot.app to start its background worker.");
      await (await import("./app/daemon")).runDaemon();
      break;
    case "desktop": {
      const { desktopEvent, watchDesktopHost } = await import("./platform/desktop");
      watchDesktopHost();
      await (await import("./app/daemon")).runDaemon({ onReady: (url) => desktopEvent({ type: "ready", url }) });
      break;
    }
    case "once":
      await (await import("./app/daemon")).runDaemon({ once: true });
      break;
    case "login":
      await (await import("./app/login")).login({ force: flags.has("--force") });
      break;
    case "reset":
      await (await import("./app/reset")).reset();
      break;
    case "update": {
      const u = await import("./updates/update");
      const info = await u.checkForUpdate();
      if (!info) console.log(`No releases published yet (${version}).`);
      else if (!info.available) console.log(`Up to date (${info.current}).`);
      else if (flags.has("--check")) console.log(`Update available: ${info.current} → ${info.latest}\n${info.url}`);
      else {
        await u.applyUpdate(info);
        console.log(`Updated to ${info.latest}. Restart the service to use it: autopilot service restart`);
      }
      break;
    }
    case "open":
      Bun.spawnSync(["open", APP_BUNDLE ?? baseUrl(loadConfig())]);
      break;
    case "service": {
      if (APP_BUNDLE) throw new Error("Autopilot.app manages its worker. Use Autopilot → Open at Login for automatic startup.");
      const s = await import("./platform/service");
      if (sub === "install") s.installService();
      else if (sub === "uninstall") s.uninstallService();
      else if (sub === "restart") s.restartService();
      else if (sub === "status") console.log(s.serviceStatus());
      else throw new Error("usage: autopilot service install|uninstall|restart|status");
      break;
    }
    case "paths":
      console.log(`home:   ${HOME_DIR}\nconfig: ${CONFIG_PATH}\nstate:  ${loadConfig().stateDir}\nlogs:   ${LOG_PATH}`);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`autopilot: ${(err as Error).message}`);
  // The desktop's open stdin would otherwise keep a failed startup alive until timeout.
  if (cmd === "desktop") process.exit(1);
  process.exitCode = 1;
}

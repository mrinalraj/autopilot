import { version } from "../package.json";
import { baseUrl, CONFIG_PATH, HOME_DIR, loadConfig, LOG_PATH } from "./config";
import { preparePath } from "./env";

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
      await (await import("./daemon")).runDaemon();
      break;
    case "once":
      await (await import("./daemon")).runDaemon({ once: true });
      break;
    case "login":
      await (await import("./login")).login({ force: flags.has("--force") });
      break;
    case "reset":
      await (await import("./reset")).reset();
      break;
    case "update": {
      const u = await import("./update");
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
      Bun.spawnSync(["open", baseUrl(loadConfig())]);
      break;
    case "service": {
      const s = await import("./service");
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
  process.exitCode = 1;
}

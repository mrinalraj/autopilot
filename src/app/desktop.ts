import { loadConfig, type Config } from "../config/config";
import { desktopDataId, desktopEvent } from "../platform/desktop";
import { runDaemon } from "./daemon";

type Probe = { kind: "ready"; boot: string } | { kind: "unavailable" | "incompatible"; message: string };

async function probe(cfg: Config): Promise<Probe> {
  try {
    const response = await fetch(`http://127.0.0.1:${cfg.port}/desktop-info`, {
      signal: AbortSignal.timeout(1500), redirect: "error", cache: "no-store",
    });
    if (response.status === 503) return { kind: "unavailable", message: "The background service is starting." };
    const info = response.ok && response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
    if (info?.app !== "autopilot" || info.protocol !== 1 || typeof info.boot !== "string") {
      return { kind: "incompatible", message: `Port ${cfg.port} is already in use by a service without compatible desktop support. If this is an older Autopilot formula, run brew upgrade --formula autopilot, then brew services restart autopilot. The app will not stop or replace it.` };
    }
    if (info.data !== desktopDataId(cfg)) {
      return { kind: "incompatible", message: `Port ${cfg.port} belongs to Autopilot with a different data folder or tracker. Use matching settings or a different port; the existing worker was left running.` };
    }
    return { kind: "ready", boot: info.boot };
  } catch {
    return { kind: "unavailable", message: "The background service is unavailable. Reconnecting… If it was stopped, run brew services start autopilot." };
  }
}

/** This process becomes a connection monitor; it never opens SQLite or owns the other daemon. */
async function followDaemon(cfg: Config, reconnecting = false): Promise<never> {
  let boot: string | null = null;
  if (!reconnecting) {
    // A competing service may have claimed its port but still be initializing.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await probe(cfg);
      if (result.kind === "incompatible") throw new Error(result.message);
      if (result.kind === "ready") { boot = result.boot; break; }
      await Bun.sleep(250);
    }
    if (!boot) throw new Error("The existing Autopilot service did not become ready. Check its logs, then retry. It was left running.");
    desktopEvent({ type: "ready", url: `http://127.0.0.1:${cfg.port}`, ownership: "external" });
  } else {
    desktopEvent({ type: "disconnected", message: "Reconnecting to the existing background service…" });
  }
  while (true) {
    await Bun.sleep(1500);
    const previousPort = cfg.port;
    // Tracker changes in setup/settings replace the active store without restarting the service.
    cfg = loadConfig();
    const result = await probe(cfg);
    if (result.kind !== "ready") {
      if (boot !== null) desktopEvent({ type: "disconnected", message: result.message });
      boot = null;
    } else if (result.boot !== boot || cfg.port !== previousPort) {
      // Includes a service restart that happened between heartbeat requests.
      if (boot !== null) desktopEvent({ type: "disconnected", message: "Reconnecting after the background service restarted…" });
      boot = result.boot;
      desktopEvent({ type: "ready", url: `http://127.0.0.1:${cfg.port}`, ownership: "external" });
    }
  }
}

export async function runDesktop(): Promise<void> {
  const cfg = loadConfig();
  // Once connected, a restarted bridge must never take over a stopped/restarting service.
  if (process.env.AUTOPILOT_DESKTOP_ATTACH_ONLY === "1") return followDaemon(cfg, true);
  try {
    await runDaemon({ onReady: (url) => desktopEvent({ type: "ready", url, ownership: "owned" }) });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code !== "EADDRINUSE") throw error;
    await followDaemon(cfg);
  }
}

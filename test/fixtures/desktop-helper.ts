import { appendFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../src/config/config";
import { Store } from "../../src/storage/db";
import { Autopilot } from "../../src/app/autopilot";
import { startWeb } from "../../src/web/server";
import { desktopEvent, watchDesktopHost } from "../../src/platform/desktop";

const home = process.env.AUTOPILOT_HOME!;
writeFileSync(`${home}/helper.pid`, String(process.pid));
if (process.env.AUTOPILOT_FIXTURE_SERVICE !== "1") watchDesktopHost();
const serve = Bun.serve.bind(Bun);
(Bun as any).serve = (options: any) => serve({ ...options, fetch(req: Request, server: any) {
  appendFileSync(`${home}/requests.jsonl`, JSON.stringify({ path: new URL(req.url).pathname, agent: req.headers.get("user-agent") }) + "\n");
  return options.fetch(req, server);
} });
const cfg = loadConfig();
const tracker = { kind: "linear", label: "Linear", me: async () => ({ name: "Smoke test", email: null, teams: [] }) };
const ap = new Autopilot(cfg, new Store(cfg.stateDir), tracker as any, {} as any);
const server = startWeb(ap, { configPath: `${home}/config.json`, gh: () => ({ installed: false, accounts: [] }) });
desktopEvent({ type: "ready", url: `http://127.0.0.1:${server.port}` });

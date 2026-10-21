import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Serves only the setup-free adoption API, writing workspace records in the fixture's temp root. */
export function fakeSupersetHost(root: string) {
  const previousHome = process.env.SUPERSET_HOME_DIR;
  const home = join(root, "host-home");
  process.env.SUPERSET_HOME_DIR = home;
  const calls: { projectId: string; worktreePath: string; branch: string; workspaceName: string }[] = [];
  const control = { fail: false, gate: null as Promise<void> | null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== "/trpc/workspaceCreation.adopt" || req.method !== "POST" || req.headers.get("authorization") !== "Bearer fixture-token") {
      return new Response("unexpected request", { status: 400 });
    }
    const { json: input } = await req.json() as { json: typeof calls[number] };
    calls.push(input);
    await control.gate;
    if (control.fail) return Response.json({ error: { json: { message: "adoption failed" } } }, { status: 500 });
    if (!input.worktreePath.startsWith(root + "/") || !existsSync(input.worktreePath)) return new Response("invalid test path", { status: 400 });
    const dir = join(root, "workspaces");
    mkdirSync(dir, { recursive: true });
    const rows = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const workspace = rows.find((w) => w.worktreePath === input.worktreePath) ?? {
      id: crypto.randomUUID(), projectId: input.projectId, type: "worktree", branch: input.branch,
      worktreePath: input.worktreePath, worktreeExists: true, archivedAt: null,
    };
    writeFileSync(join(dir, `${workspace.id}.json`), JSON.stringify(workspace));
    return Response.json({ result: { data: { json: { workspace, terminals: [], warnings: [] } } } });
  } });
  const manifest = join(home, "host", "test-organization", "manifest.json");
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, authToken: "fixture-token" }));
  return { calls, control, manifest, close() {
    server.stop(true);
    if (previousHome === undefined) delete process.env.SUPERSET_HOME_DIR;
    else process.env.SUPERSET_HOME_DIR = previousHome;
  } };
}

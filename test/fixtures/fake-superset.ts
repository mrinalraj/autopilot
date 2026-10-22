// Copied into a test's temp directory with an absolute Bun shebang. Never calls Superset.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = dirname(process.argv[1]);
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
const flag = (name: string) => args[args.indexOf(name) + 1];
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const control = existsSync(join(root, "control.json")) ? read(join(root, "control.json")) : {};
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
const die = (message: string): never => { console.error(message); process.exit(1); };
if (control.fail === command) die(control.error ?? "fake Superset failure");
if (!["status", "auth"].includes(args[0]) && !args.includes("--local")) die("local host must be explicit");
if (control.offline && args[0] !== "status") die("Host service for this machine isn't running");
const rows = (kind: string) => {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => read(join(dir, f)));
};
const save = (kind: string, row: any) => {
  mkdirSync(join(root, kind), { recursive: true });
  writeFileSync(join(root, kind, `${row.id}.json`), JSON.stringify(row));
};
const git = (path: string, ...argv: string[]) => {
  if (!resolve(path).startsWith(root + "/")) die("fake may only change test repos");
  const p = Bun.spawnSync(["git", "-C", path, ...argv], { stdout: "pipe", stderr: "pipe", env: process.env });
  if (p.exitCode) die(p.stderr.toString());
};
let result: any;
switch (command) {
  case "auth whoami": result = { organizationId: "test-organization", userId: "test-user" }; break;
  case "status --json": result = { running: !control.offline && !control.staleStatus, healthy: !control.offline && !control.staleStatus, stale: !!control.staleStatus }; break;
  case "projects list": result = control.malformed ? {} : rows("projects"); break;
  case "projects create": {
    const project = { id: crypto.randomUUID(), name: flag("--name"), path: flag("--import"), repo: "-" };
    save("projects", project);
    result = { projectId: project.id }; // Consumers must rediscover the registered project.
    break;
  }
  case "workspaces list": result = control.malformed ? {} : rows("workspaces"); break;
  case "workspaces create": {
    const project = rows("projects").find((p) => p.id === flag("--project"));
    if (!project) die("missing project");
    const branch = flag("--branch");
    const path = join(root, "worktrees", project.name, branch);
    const hasBranch = Bun.spawnSync(["git", "-C", project.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
    git(project.path, "worktree", "add", "-q", ...(hasBranch ? [path, branch] : ["-b", branch, path, args.includes("--base-branch") ? flag("--base-branch") : "main"]));
    const workspace = { id: crypto.randomUUID(), projectId: project.id, type: "worktree", branch,
      worktreePath: path, worktreeExists: true, archivedAt: null };
    save("workspaces", workspace);
    result = { workspace, terminals: [], agents: [], alreadyExists: false };
    break;
  }
  case "terminals create": {
    if (!rows("workspaces").some((w) => w.id === flag("--workspace"))) die("missing workspace");
    result = { terminalId: crypto.randomUUID(), status: "created" };
    break;
  }
  case "workspaces open": result = { url: `superset://v2-workspace/${args[2]}` }; break;
  case "workspaces archive": {
    const workspace = rows("workspaces").find((w) => w.id === args[2]);
    if (!workspace || workspace.type !== "worktree") die("not an isolated worktree");
    const project = rows("projects").find((p) => p.id === workspace.projectId);
    if (!control.keepWorktree) git(project.path, "worktree", "remove", "--force", workspace.worktreePath);
    save("workspaces", { ...workspace, archivedAt: new Date().toISOString(), worktreeExists: false });
    result = { deleted: [workspace.id] };
    break;
  }
  default: die(`unexpected command: ${command}`);
}
console.log(JSON.stringify(result));

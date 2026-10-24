import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const data = mkdtempSync(join(tmpdir(), "autopilot-browser-"));
const binary = join(data, "autopilot");
const fake = join(data, "fake-agent.sh");
const planner = join(data, "fake-planner.ts");
writeFileSync(
  planner,
  `#!/usr/bin/env bun
const headers={"Content-Type":"application/json","Authorization":"Bearer "+process.env.AUTOPILOT_TOKEN,"X-Autopilot-Session":process.env.AUTOPILOT_SESSION_ID,"X-Autopilot-Generation":process.env.AUTOPILOT_GENERATION};
async function request(path,body){const response=await fetch(process.env.AUTOPILOT_URL+"/api/v1"+path,{headers,method:body?"POST":"GET",body:body?JSON.stringify(body):undefined});if(!response.ok)throw new Error(await response.text());return response.json()}
async function plan(){const s=await request("/snapshot");for(const i of s.issues.filter(i=>!i.planIds?.length&&i.status!=="done"&&i.status!=="canceled")){await request("/plans",{workspaceId:i.workspaceId,issueId:i.id,title:"Plan: "+i.title,summary:"Fake coordinator plan",tasks:[{id:"implement",issueId:i.id,title:i.title,prompt:"Implement the ticket",harness:"test-agent",repositoryIds:s.repositories.map(r=>r.id),dependsOn:[]}]})}await request("/signal",{state:"idle",message:"Ready for triage"});console.log("PLANNER READY")}
await plan();for await(const line of console){await plan()}
`,
  { mode: 0o700 },
);
writeFileSync(
  fake,
  '#!/bin/sh\necho "FAKE AGENT READY"\nwhile IFS= read -r line; do printf "RECEIVED %s\\n" "$line"; done\n',
  { mode: 0o700 },
);
writeFileSync(
  join(data, "settings.json"),
  JSON.stringify({
    profiles: [
      {
        id: "test-planner",
        label: "Test Planner",
        command: planner,
        args: [],
        promptMode: "arg",
        resumeArgs: [],
      },
      ...["claude", "codex", "agy"].map((id) => ({
        id,
        label: id,
        command: fake,
        args: [],
        promptMode: "arg",
        resumeArgs: ["{conversation}"],
      })),
      {
        id: "test-agent",
        label: "Test Agent",
        command: "/bin/sh",
        args: [fake],
        promptMode: "arg",
        resumeArgs: [fake, "{conversation}"],
      },
    ],
  }),
);
execFileSync(
  "go",
  ["build", "-tags", "webassets", "-o", binary, "./cmd/autopilot"],
  { cwd: resolve(".."), stdio: "inherit" },
);
const child = spawn(binary, ["serve"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AUTOPILOT_DATA_DIR: data,
    AUTOPILOT_LISTEN: "127.0.0.1:4789",
    AUTOPILOT_ALLOWED_HOSTS: "127.0.0.1:4789",
  },
});
let closing = false;
function cleanup() {
  if (closing) return;
  closing = true;
  child.kill("SIGTERM");
  const socket = join(
    tmpdir(),
    "autopilot-" +
      createHash("sha256").update(data).digest("hex").slice(0, 16) +
      ".sock",
  );
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {}
  child.once("exit", () => {
    rmSync(data, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
child.on("exit", (code) => {
  if (!closing) {
    rmSync(data, { recursive: true, force: true });
    process.exit(code || 0);
  }
});

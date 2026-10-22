import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { claudeCommand } from "../../src/workspaces/common";

test("launcher commands execute custom binary paths and pass prompts and directories literally", () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-command-"));
  try {
    const cfg = loadConfig("/nonexistent");
    cfg.launch.claudeBin = join(root, "user's claude $binary;#");
    writeFileSync(cfg.launch.claudeBin, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
    const request = { prompt: "Read the user's brief; $(printf unsafe) `printf unsafe`", addDirs: ["/briefs with spaces", "/work/user's #extra?%"] };
    const proc = Bun.spawnSync(["/bin/sh", "-c", claudeCommand(cfg, request)], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual([request.prompt, "--add-dir", ...request.addDirs]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

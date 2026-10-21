import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config";
import { createLLM } from "../../src/triage/llm";

const dir = mkdtempSync(join(tmpdir(), "autopilot-llm-"));
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

test("claude -p is found on a PATH extended after startup (brew services starts with a bare one)", async () => {
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  writeFileSync(join(bin, "fake-claude-for-test"), `#!/bin/sh\necho '{"structured_output":{"ok":true}}'\n`);
  chmodSync(join(bin, "fake-claude-for-test"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`; // what preparePath() does under launchd
  const cfg = { ...loadConfig("/nonexistent"), stateDir: join(dir, "state") };
  cfg.llm = { ...cfg.llm, provider: "cli", claudeBin: "fake-claude-for-test" };
  const out = await createLLM(cfg).json<{ ok: boolean }>({ system: "s", prompt: "p", schema: { type: "object", properties: {} } });
  expect(out).toEqual({ ok: true });
});

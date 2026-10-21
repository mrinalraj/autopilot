import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

test("source configuration still resolves to the project root after moving into config/", () => {
  const env = { ...process.env };
  delete env.AUTOPILOT_HOME;
  delete env.AUTOPILOT_CONFIG;
  const configModule = resolve(import.meta.dir, "../../src/config/config.ts");
  const result = Bun.spawnSync([process.execPath, "-e", `import { HOME_DIR, CONFIG_PATH, COMPILED } from ${JSON.stringify(configModule)}; console.log(JSON.stringify({ HOME_DIR, CONFIG_PATH, COMPILED }));`], {
    env, cwd: tmpdir(), stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const root = resolve(import.meta.dir, "../..");
  expect(JSON.parse(result.stdout.toString())).toEqual({ HOME_DIR: root, CONFIG_PATH: resolve(root, "config.json"), COMPILED: false });
});

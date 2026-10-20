import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { Health } from "../src/health";

test("missing Claude CLI and Supacode are required items; the app-install tip is browser-only", async () => {
  const base = loadConfig("/nonexistent");
  const cfg = {
    ...base,
    llm: { ...base.llm, provider: "cli" as const, claudeBin: "/usr/bin/false" },
    launch: { ...base.launch, supacodeBin: "/nonexistent/supacode" },
  };
  const items = await new Health(cfg).refresh();
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  expect(byId.claude?.level).toBe("required");
  // Only flagged when the app bundle is absent too (the deeplink fallback needs the app).
  expect(!!byId["launcher-supacode"]).toBe(!(await Bun.file("/Applications/supacode.app/Contents/Info.plist").exists()));
  expect(byId["install-app"]).toMatchObject({ level: "optional", browserOnly: true });
});

import { expect, test } from "bun:test";
import { startOAuthCallback } from "../../src/web/oauth-callback";

test("loopback OAuth validates state, reports errors, and only forwards valid codes", async () => {
  const codes: string[] = [];
  const errors: Error[] = [];
  const server = startOAuthCallback({ port: 0, label: "<Tracker>", state: () => "expected", onCode: (code) => codes.push(code), onError: (error) => errors.push(error) });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/wrong`)).status).toBe(404);
    expect(await (await fetch(`${base}/callback?state=wrong&code=secret`)).text()).toContain("Unexpected callback");
    expect(await (await fetch(`${base}/callback?state=expected`)).text()).toContain("Unexpected callback");
    expect(await (await fetch(`${base}/callback?error=denied&error_description=no`)).text()).toContain("Authorization failed");
    expect(codes).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual([
      "authorization callback had a bad state or no code", "authorization callback had a bad state or no code", "authorization failed: denied no",
    ]);
    const response = await fetch(`${base}/callback?state=expected&code=approved`);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("signed in to &lt;Tracker&gt;");
    expect(codes).toEqual(["approved"]);
  } finally {
    server.stop(true);
  }
});

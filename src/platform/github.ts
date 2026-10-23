export interface GithubStatus {
  installed: boolean;
  accounts: { name: string; active: boolean }[];
}

/** gh on this machine: installed, and the github.com accounts logged in (for the PR-tracking picker). */
export function githubStatus(): GithubStatus {
  if (!Bun.which("gh", { PATH: process.env.PATH })) return { installed: false, accounts: [] };
  try {
    const p = Bun.spawnSync(["gh", "auth", "status", "-h", "github.com"], { stdout: "pipe", stderr: "pipe", env: process.env });
    const accounts: GithubStatus["accounts"] = [];
    for (const line of `${p.stdout}${p.stderr}`.split("\n")) {
      const acct = /Logged in to github\.com account (\S+)/.exec(line)?.[1];
      if (acct) accounts.push({ name: acct, active: false });
      else if (/Active account: true/.test(line) && accounts.length) accounts[accounts.length - 1].active = true;
    }
    return { installed: true, accounts };
  } catch {
    return { installed: true, accounts: [] };
  }
}

export const githubAccounts = (): string[] => githubStatus().accounts.map((a) => a.name);

/** UI diagnostics must never block the daemon's event loop. */
export async function githubStatusAsync(): Promise<GithubStatus> {
  if (!Bun.which("gh", { PATH: process.env.PATH })) return { installed: false, accounts: [] };
  const p = Bun.spawn(["gh", "auth", "status", "-h", "github.com"], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const accounts: GithubStatus["accounts"] = [];
  for (const line of `${out}\n${err}`.split("\n")) {
    const name = /Logged in to github\.com account (\S+)/.exec(line)?.[1];
    if (name) accounts.push({ name, active: false });
    else if (/Active account: true/.test(line) && accounts.length) accounts[accounts.length - 1].active = true;
  }
  return { installed: true, accounts };
}

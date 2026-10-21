/** The macOS folder picker (several at once); null when cancelled. Runs on this Mac, so it can show a dialog. */
export async function chooseFolders(): Promise<string[] | null> {
  const proc = Bun.spawn(
    ["osascript", "-e", 'tell application "System Events"', "-e", "activate",
      "-e", 'set picked to choose folder with prompt "Pick parent folders or repos for Autopilot" with multiple selections allowed',
      "-e", "end tell", "-e", 'set out to ""', "-e", "repeat with f in picked", "-e", "set out to out & POSIX path of f & linefeed",
      "-e", "end repeat", "-e", "return out"],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const timer = setTimeout(() => proc.kill(), 600_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) {
    if (/-128|cancel/i.test(err)) return null;
    throw new Error(err.trim() || "the folder picker didn't open");
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

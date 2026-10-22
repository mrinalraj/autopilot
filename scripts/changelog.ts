import { readFileSync } from "node:fs";

export function changelogSection(markdown: string, version = "Unreleased"): { version: string; date: string | null; body: string } {
  const name = version.replace(/^v(?=\d)/, "");
  const headings = [...markdown.matchAll(/^## \[([^\]\r\n]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*\r?$/gm)];
  const matches = headings.filter((h) => h[1] === name);
  if (matches.length !== 1) throw new Error(`Expected one changelog section for "${name}"; found ${matches.length}.`);
  const heading = matches[0];
  const next = headings[headings.indexOf(heading) + 1];
  const body = markdown.slice(heading.index! + heading[0].length, next?.index).trim();
  if (!body) throw new Error(`The changelog section for "${name}" is empty.`);
  return { version: name, date: heading[2] ?? null, body };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (args.includes("--help")) {
    console.log("Usage: bun run changelog [Unreleased|version] [--json]");
  } else {
    try {
      if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--json")) {
        throw new Error("Usage: bun run changelog [Unreleased|version] [--json]");
      }
      const notes = changelogSection(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), positional[0]);
      console.log(args.includes("--json") ? JSON.stringify(notes, null, 2) : notes.body);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  }
}

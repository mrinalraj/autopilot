import { expect, test } from "bun:test";
import { changelogSection } from "../scripts/changelog";

const markdown = `# Changelog

Introductory instructions.

## [Unreleased]

### Fixed

- Pending fix.

## [0.1.0-beta.9] - 2026-10-22

### Added

- Released feature.
`;

test("changelog exports only the requested notes with reusable version and date fields", () => {
  expect(changelogSection(markdown)).toEqual({ version: "Unreleased", date: null, body: "### Fixed\n\n- Pending fix." });
  const released = { version: "0.1.0-beta.9", date: "2026-10-22", body: "### Added\n\n- Released feature." };
  expect(changelogSection(markdown, "0.1.0-beta.9")).toEqual(released);
  expect(changelogSection(markdown, "v0.1.0-beta.9")).toEqual(released);
  expect(changelogSection(markdown.replaceAll("\n", "\r\n"), "v0.1.0-beta.9")).toMatchObject({ version: released.version, date: released.date });
});

test("missing, empty and duplicate changelog sections fail instead of exporting other notes", () => {
  expect(() => changelogSection(markdown, "0.1.0-beta.8")).toThrow("found 0");
  expect(() => changelogSection("## [Unreleased]\n\n## [0.1.0-beta.9] - 2026-10-22\n\nPrevious notes.")).toThrow("empty");
  expect(() => changelogSection(markdown + "\n## [Unreleased]\nDuplicate notes.\n")).toThrow("found 2");
});

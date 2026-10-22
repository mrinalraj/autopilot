# Changelog workflow

`CHANGELOG.md` at the repository root is the canonical record. Keep entries under `## [Unreleased]`
until a release is explicitly requested. Commit the notes with the implementation so they are
preserved on the branch and included when it merges.

Group concise, user-visible entries under `### Added`, `### Changed`, `### Fixed`, or `### Removed`.
Describe the final behavior, not intermediate experiments. Keep existing version sections intact;
do not generate a new history from commit titles or duplicate it in another hand-maintained file.

## Reusing the notes

```sh
bun run changelog                           # Unreleased section as Markdown
bun run changelog --json                    # { version, date, body }
bun run changelog 0.1.0-beta.9               # one historical version
bun run changelog v0.1.0-beta.9 --json       # Git tag spelling also works
bun run changelog > /tmp/autopilot-notes.md # reusable notes file
```

These commands only read the changelog and print the requested section. They do not change a
version, create a tag, commit, push, or publish anything. Missing, duplicate and empty sections fail
with a nonzero exit code to prevent accidentally publishing the wrong notes.

Use the Markdown output as a PR summary, GitHub release body or documentation excerpt. Other tools
can consume the JSON `body`, `version`, and nullable `date` fields. The exporter does not include
the changelog's introductory text or other versions.

## When a release is requested

1. Move the Unreleased entries to `## [<version>] - YYYY-MM-DD`, using the release date. Keep a new
   `## [Unreleased]` section at the top and update `package.json` as part of the release commit.
2. Export that exact version with `bun run changelog <version> > /tmp/autopilot-release-notes.md`.
3. Follow the release process in `CLAUDE.md`, passing
   `--notes-file /tmp/autopilot-release-notes.md` to its `gh release create` command.

Keep notes on pending branches under Unreleased. When branches overlap, merge their entries and
remove duplicates rather than replacing one branch's notes with another's.

# Release plan: 0.1.0-beta.10

Prepared and executed 2026-10-23. **Completed:** beta.10 is published and both Homebrew packages
are live. See the [release handoff and verification](releases/0.1.0-beta.10.md) for final results
and remaining manual QA. The plan and initial evidence below are retained as a historical snapshot.

## Release target

- Version: `0.1.0-beta.10`, published as a GitHub prerelease.
- Title: **Optional desktop app, faster Settings, and a more compact dashboard**.
- Ship the formula and native app together for Apple Silicon and Intel.
- Continue the current ad-hoc signing approach, with explicit not-notarized and first-launch
  approval instructions. No Developer ID or notarization credentials are assumed.
- Keep the app self-contained. It connects to a compatible running formula daemon, or starts
  its bundled worker when no daemon is listening. Merely installing the formula does not start it.

Canonical release notes remain in `CHANGELOG.md`; this plan does not replace them.

## Evidence at planning time (superseded by the release handoff)

| Item | Status |
| --- | --- |
| Published release | GitHub lists beta.9 as the newest release, marked prerelease |
| Remote main | `9c294f350e5bce0e4ea1e69ff5074170a2791a77`, matching local HEAD |
| Working branch | `feat/desktop-formula-coexistence`; implementation is uncommitted |
| Pull request | No open PR at the time of checking |
| Automated suite | 167 passing tests across 29 files |
| Typecheck / whitespace | Passed |
| Browser verification | Passed fixed scrolling, four-column cards at 1180px, logs at 320–1440px, modal focus, draft retention, validation, busy-button sizing, progress DOM continuity, and reduced motion |
| Apple Silicon app | Built; native WebKit loading, crash recovery, external-service attachment/reconnection and service survival after app exit passed |
| Release artifacts | Must be rebuilt after the version bump; current artifacts are beta.9 and are not a release candidate |
| Homebrew migration | Actual beta.9-to-beta.10 cask/formula upgrade and uninstall checks remain |
| Intel | Fresh beta.10 build and helper checks remain; physical Intel hardware QA is not yet established |

## 1. Prepare and review the change

1. Review the implementation and documentation diff, including the new desktop bridge,
   Settings metadata loader and Settings browser script.
2. Include only intended product, documentation and test files. Leave unrelated local skill,
   agent and generated report files out of the release commit.
3. Add the migration instructions below to the canonical release notes before versioning them.
   Distinguish existing formula users, existing beta.9 cask users and new installations.
4. Commit the feature branch and open a PR to `main` with the completed validation and remaining
   packaging checks stated accurately.
5. Review and squash-merge the PR. Use a clean checkout of the resulting `main` commit for release work.

## 2. Version and build the candidate

1. On main, change `package.json` to `0.1.0-beta.10`; move Unreleased notes into a dated beta.10
   section using the actual release date, and retain an empty Unreleased section.
2. Update the latest-release reference in `CLAUDE.md` and commit the release metadata.
3. Build from that exact commit:

   ```sh
   bun run build:release
   scripts/brew-formula.sh
   bun run cask
   ```

   The CLI build clears `dist/`; it must run before the desktop build. Generate both package
   definitions only after all architecture artifacts exist.
4. Verify each helper reports beta.10 and expected paths using disposable `AUTOPILOT_HOME`
   directories. Verify native signatures and both checksum manifests. Run the Intel helper
   under Rosetta when available, without claiming this substitutes for Intel hardware testing.
5. Re-run required automated checks against the release commit and run `bun run test:app`
   against the freshly built native bundle. Use isolated data and fake services.
6. Create the annotated `v0.1.0-beta.10` tag on the verified release commit. Never move an
   existing pushed tag or rebuild different bytes under a published release version.

Expected assets (six):

- `autopilot-0.1.0-beta.10-darwin-arm64.tar.gz`
- `autopilot-0.1.0-beta.10-darwin-x64.tar.gz`
- `checksums.txt`
- `autopilot-0.1.0-beta.10-macos-arm64.zip`
- `autopilot-0.1.0-beta.10-macos-x64.zip`
- `desktop-checksums.txt`

## 3. Verify packaging and migration before public rollout

Use a disposable macOS test account or other controlled Homebrew environment with disposable
Autopilot data. Preserve the user's working installation. Exercise actual generated formula/cask
definitions against the candidate assets; runtime mocks do not verify Homebrew artifact cleanup.

| Scenario | Required result |
| --- | --- |
| Fresh formula only | CLI works, service starts, browser opens; no native app is required |
| Fresh app only | App starts its bundled worker; Quit stops that worker |
| Formula, then app | App attaches; only one daemon owns the data; Quit leaves the service running |
| Older formula, new app | App gives upgrade/restart guidance without disturbing the old daemon; after upgrade and restart it connects |
| Beta.9 cask upgrade | Normal cask upgrade removes the old cask-owned CLI link, retains data/sign-ins, and keeps app-only use working |
| Upgraded app, then formula | Quit app, install/start formula, reopen app; formula owns the daemon and its CLI link |
| Remove new cask | Formula service and browser UI continue; shared data remains, including with the new cask's zap rules |
| Formula restart | Attached app reconnects and does not start a competing worker |
| Mixed beta.10-compatible versions | Attachment uses the discovery protocol and matching data, rather than requiring identical package versions |

Check first-launch approval, Settings scroll/navigation and a representative modal in the native
window. Record any manual OAuth, notification, Open at Login or Intel hardware checks that remain
unverified in the beta release notes. Do not label untested paths as passed.

## 4. Publish and update Homebrew

1. Push the verified main release commit and annotated tag.
2. Export the canonical notes with `bun run changelog 0.1.0-beta.10`; prepare a GitHub draft
   prerelease with those notes and all six verified assets.
3. Prepare one tap commit updating both `Formula/autopilot.rb` and `Casks/autopilot.rb` from
   the generated files. Preserve formula rename compatibility. Verify versions, URLs, checksums,
   the absence of a cask CLI `binary` stanza, and preservation of shared data by the cask's zap rules.
4. Publish the GitHub prerelease, then promptly push the prepared tap commit. Published assets
   must be downloadable before Homebrew points at them. Keep this interval short because existing
   beta clients discover GitHub releases independently of tap publication.
5. Verify anonymous access to all release assets, compare downloaded checksums, confirm both
   Homebrew entries resolve to beta.10, and exercise the documented install/upgrade commands in
   the controlled test environment.

## User migration instructions

Existing formula users keep the formula installed. Upgrade and restart it before adding the app:

```sh
brew update
brew upgrade --formula autopilot
brew services restart autopilot
brew install --cask mrinalraj/tap/autopilot
open -a Autopilot
```

Existing beta.9 cask users can remain app-only by quitting the app, upgrading the cask, and
reopening it. To add the independent service, quit the app and use this order:

```sh
brew update
brew upgrade --cask autopilot
brew install --formula mrinalraj/tap/autopilot
brew services start autopilot
open -a Autopilot
```

Upgrade the old cask before installing the formula because beta.9 supplied the `autopilot` CLI
link. Use a normal upgrade: the old beta.9 cask's `--zap` rules remove shared Application Support
data, while the new cask's rules preserve it. No reset or data deletion is part of migration.

Fresh installs can install/start the formula and run `autopilot open`, then install the optional
cask later. App-only installation remains supported. Both package types keep the name `autopilot`;
use explicit `--formula` and `--cask` flags for package operations.

When both are present, the daemon serves the web UI and determines the dashboard's version.
Upgrading only the native app does not update an attached formula daemon or its web UI. Upgrade
each installed package separately.

## Recovery

If candidate validation fails before publication, fix the candidate and repeat the relevant checks.
If a defect is found after publication, preserve published tags/assets and prepare beta.11 with
the fix. Do not silently replace beta.10 archives or instruct users to erase settings. Investigate
any package rollback against a backup of the test data before recommending it to users.

# Default branch transition

Prepared on 26 October 2026. The requested destination is `autopilot-cloud`;
keep that branch name and change GitHub's default, without rewriting `main`.
The repository setting has not been changed by this preparation.

## Verified source and archive

| Ref | Verified revision | Role |
| --- | --- | --- |
| `origin/main` | `5473a457a27272aaabcaa6d7109dbcdd39e2b545` | Current default; old Bun/macOS app |
| `origin/obselete` | `5473a457a27272aaabcaa6d7109dbcdd39e2b545` | Existing remote archive, identical to `main` |
| `8fd2bf1` | `8fd2bf1341b8457d3be3d2e90c18a2a0ddae7b8d` | Reproducible Go/React baseline |
| `5042ed5` | `5042ed59e266ec7fd6f28860932a18d4fd34616f` | PWA/local packaging and retirement of old runtime |

The candidate is descended from `main`; no conflict, force-push or source migration
is needed. The old code, migrations, Homebrew scripts and native wrapper already
exist on the archive. Preserve its existing spelling because documentation links
use it. Do not push `private-history`. Existing releases and tags stay unchanged.

## Preparation changes

- `cloud-checks.yml` runs Go race tests/vet, embedded builds/tests, isolated local
  startup checks, all browser/PWA tests, four package builds and Linux installation
  smoke checks on cloud-branch pushes and pull requests. It publishes no releases.
- The Pages workflow on the candidate accepts `main`/`autopilot-cloud` pushes but
  deploys only from the current default. Its manual trigger remains available.
- The legacy site's setup/installation/documentation links explicitly target
  `obselete`, so they survive a new root README. Product artwork, existing release
  URLs and Homebrew commands remain unchanged.

## Local verification

Passed on macOS arm64 against disposable data and fake harnesses:

- `make test`: 2 changelog tests, Go race suite and vet.
- `make build` and `cd cloud && go test -mod=readonly -tags webassets ./...`.
- `cd cloud/web && bun run test`: all 6 workflows passed, including PWA cache
  boundaries, offline recovery, installability and recovery after a missing chunk.
- `python3 cloud/tests/local_smoke.py cloud/bin/autopilot-cloud`.
- `make package`: macOS/Linux arm64/amd64 archives built.
- `python3 cloud/tests/package_smoke.py cloud/dist/autopilot-cloud-darwin-arm64.tar.gz`:
  install/reinstall into a path containing spaces, persistence, legacy executable
  preservation and corrupt-upgrade rejection passed.
- Both workflow files pass actionlint 1.7.7; `git diff --check` passes.

Local artifacts are verification builds marked `-dirty`, because the user's
pre-existing `.gitignore` edits and this preparation were present. They are not
release artifacts. The real local instance remains stopped and its data untouched.

Actual installation through an OS browser menu, Safari/mobile acceptance and Docker
runtime testing remain outside these checks. Other architectures were cross-built,
not run locally. The earlier intermittent coordinator attachment failure documented
in `local-pwa-handoff.md` did not recur; this is not a claim that it was fixed.
Require a green Cloud checks run for the pushed preparation commit before switching.

The first Linux CI run exposed a fixture portability bug: the test harness invoked
`/bin/sh --version` for availability, which works with macOS's shell but fails with
Ubuntu's dash. The fixture now launches its executable script directly and both
fake harnesses handle `--version` without entering their agent loops. The workbench
test explicitly checks that its launcher is enabled. Production code and test
timeouts were not changed; this is separate from the prior attachment issue.

## Apply after approval

Use the personal `mrinalraj` GitHub credentials for these repository settings; the
currently active CLI account `mrinalraj1` cannot administer this repository. Select
the personal token for individual commands without changing the global active login.
Personal credentials were verified to have repository admin access.

1. Fetch origin again and verify the archive still contains the old default tip.
   Confirm the candidate includes the two audited commits and the preparation commit.
   Check the Cloud checks workflow for that exact candidate commit.
2. In **Settings → Environments → github-pages → Deployment branches**, change the
   existing `main` branch rule (ID `64056869` at preparation time) to `autopilot-cloud`.
   The environment currently uses custom branch policies. Replace the rule rather
   than leaving both: old `main` still contains its original Pages workflow, which
   does not check the repository's default branch.
3. Change **Settings → Branches → Default branch** from `main` to `autopilot-cloud`
   (CLI: `gh repo edit mrinalraj/autopilot --default-branch autopilot-cloud`). Do not
   rename/delete branches, move `main`, publish a release or touch installed data.
4. Run **Deploy website to GitHub Pages** on `autopilot-cloud` so the existing site's
   corrected legacy documentation links reach the published site. This deploys the
   static site only, not the application or packages.
5. Verify the default via the repository API, check the Pages deployment and links,
   then run `git remote set-head origin -a`. Existing local `main` checkouts remain
   on the old code; new clones will use `autopilot-cloud`.

There were no open pull requests, repository rulesets or protected branches at
preparation time. Recheck before applying; if any have appeared, review their base
branches and checks before changing settings.

## Rollback

Restore GitHub's default to `main` and the Pages environment rule to `main`, then
refresh `origin/HEAD`. No Git history needs resetting. The old default and archive
are preserved throughout. Application data and existing installations are separate
from the default-branch setting.

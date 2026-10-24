# Autopilot

Autopilot is a Go service and React interface for local workspaces, approved task plans,
Git worktrees and persistent agent terminals. Run the bundled UI in a browser or install
it as a PWA. The same application also supports a Docker server installation.

```sh
make build
./cloud/bin/autopilot-cloud start
```

Open **http://127.0.0.1:4780**. Build requirements: Go 1.26.2 and Bun 1.3.14.
Runtime requirements: Git and tmux, plus the authenticated agent CLIs you choose.
The local command uses your host CLI configuration. No frontend dev server is needed.

- [Local package, install, start, stop, upgrade and PWA instructions](docs/local-install.md)
- [Cloud configuration, Docker, integrations and workflows](cloud/README.md)
- [Source provenance and audit](docs/cloud-baseline.md)
- [Implementation and verification handoff](docs/local-pwa-handoff.md)
- [Changelog](CHANGELOG.md)

`make package` builds relocatable macOS/Linux arm64/amd64 archives without installing
anything. Windows is not supported by the Unix/tmux backend; a browser on another
platform can connect to a supported server.

The earlier Bun/macOS app is preserved on [`obselete`](https://github.com/mrinalraj/autopilot/tree/obselete)
at `5473a457a27272aaabcaa6d7109dbcdd39e2b545`, including migrations and native/Homebrew
packaging. Existing installations and [published releases](https://github.com/mrinalraj/autopilot/releases)
remain usable. This application has separate data and does not migrate the old database.
The [static marketing site](site/) continues to describe the published legacy beta.

This distribution is for one trusted operator and trusted agent processes. Remote
hosting needs a private authenticated transport; there is no public multi-user login.

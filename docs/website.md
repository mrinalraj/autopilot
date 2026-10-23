# Autopilot website

The launch site is in `site/`. It is plain HTML, CSS, and JavaScript, with local fonts, poster,
and the 20-second launch video. No package installation, build service, API keys, or backend
are needed. Only `site/` is uploaded to GitHub Pages.

## Preview locally

From the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

Open http://localhost:4173. The preview gallery shows the actual app rendered with fictional data. Tabs switch between the
dashboard, approval dialog, and settings; each image opens at full size. The video plays only on request.

## Publish with GitHub Pages

1. Commit `site/` and `.github/workflows/pages.yml` to the repository and merge into `main`.
2. In the GitHub repository, open **Settings → Pages → Build and deployment** and set
   **Source** to **GitHub Actions**.
3. Open **Actions → Deploy website to GitHub Pages → Run workflow**, selecting `main`.
   Future pushes to `main` that change `site/` also deploy automatically.
4. Open the URL shown on the deployment. For `mrinalraj/autopilot`, the default URL is
   https://mrinalraj.github.io/autopilot/.

The workflow deploys from `main` only and uses GitHub's built-in token with Pages/OIDC
permissions; no personal access token is needed. If the environment has branch restrictions,
allow `main` in the `github-pages` environment. See the
[GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Customize

- Content and installation commands: `site/index.html`.
- Palette, layout and responsive styles: `site/styles.css`.
- Preview gallery, full-size dialog, keyboard tabs and copy buttons: `site/site.js`.
- Product captures: `site/assets/app-{dashboard,approval,settings}.jpg`.
- Planned plugin support: the `coming-next` section of `site/index.html`.
- Video and poster: `site/assets/autopilot-launch.mp4` and `autopilot-poster.jpg`.
- Link preview: `site/assets/social.jpg`.
- A custom domain or different repository: update the canonical, `og:url`, and `og:image`
  URLs in `site/index.html`. Configure the custom domain in GitHub Pages settings; the site's
  relative asset paths work at a domain root or under a project subpath.

Current-feature copy is grounded in the project README. The roadmap contains one user-provided
plan: developing and installing plugins for trackers, LLMs, and launchers. It is labeled planned.
All product captures use fictional tickets, repos, accounts, email addresses, paths, and PRs.
The native-app installation tab includes the public beta's signing and first-launch note.
Keep commands and requirements in sync with README.md when releasing.

## Accessibility and assets

The page includes a skip link, semantic headings, keyboard-operable tabs, native FAQ details,
visible focus, a video description, and reduced-motion handling. Without JavaScript, the
initial app preview, both installation methods, navigation, FAQ, and native video controls remain usable.

Inter is bundled under the SIL Open Font License; see `site/assets/fonts/LICENSE.txt`.
The launch film uses Happy Beats / Business Moves Vol. 12 by ende.app and Kenney CC0 sound
effects bundled with the brag skill. The product mark matches the app’s current gradient A. The GitHub mark and CLI terminal icon
are local SVGs, so their rendering does not depend on an icon font or third-party CDN.

## Regenerate product previews

Run `TZ=UTC bun scripts/generate-site-previews.ts`. This renders `.dev/site-fixtures/` using
`src/web/views/dashboard.ts`, `src/web/views/settings.ts`, and the production stylesheet.
The script supplies a fixed fictional dataset and does not load app configuration, stored
tickets, credentials, or tracker APIs. No user-supplied screenshot is copied into these outputs.

Serve the fixture directory on a loopback port, capture at a 1440×1000 CSS viewport, and save:

- `dashboard.html` → `app-dashboard.jpg`.
- `settings.html` → `app-settings.jpg`.
- `dashboard.html#m-APP-142` → `app-approval.jpg` (scroll the modal until Launch is visible).

`launched.html` and `merged.html` provide successive states of the same fictional ticket for
the launch film. Keep the source captures outside `site/`; only the final cropped images ship.

Validation covered Chrome layouts at 320–1440 CSS pixels, gallery tabs and full-size viewing,
keyboard navigation, install command copying, video playback, and project-subpath asset URLs.
Touch feedback and safe-area behavior still need a physical phone check.

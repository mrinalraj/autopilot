import styles from "../assets/styles.css" with { type: "text" };
import liveScript from "../assets/live.js" with { type: "text" };
import settingsScript from "../assets/settings.js" with { type: "text" };
import { esc } from "./escape";

/** Pure page rendering; the HTTP layer supplies the CSP nonce. */
export function renderPage(title: string, body: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml"><link rel="icon" href="/icons/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Autopilot">
<meta name="theme-color" content="#f4f4f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)">
<style>${styles}</style></head>
<body><noscript><style>.settings-panel{display:block!important}</style></noscript><div class="navigation-progress" aria-hidden="true"></div><div class="sr-only" id="navigation-status" role="status"></div><main id="main-content">${body}</main><script nonce="${nonce}">${liveScript}\n${settingsScript}</script></body></html>`;
}

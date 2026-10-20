import apple from "../public/icons/apple-touch-icon.png" with { type: "file" };
import favicon from "../public/icons/favicon-32.png" with { type: "file" };
import icon192 from "../public/icons/icon-192.png" with { type: "file" };
import icon512 from "../public/icons/icon-512.png" with { type: "file" };
import maskable512 from "../public/icons/icon-maskable-512.png" with { type: "file" };
import iconSvg from "../public/icons/icon.svg" with { type: "file" };
import maskableSvg from "../public/icons/icon-maskable.svg" with { type: "file" };

/** Icon files, embedded in the compiled binary. */
export const ICONS: Record<string, string> = {
  "apple-touch-icon.png": apple,
  "favicon-32.png": favicon,
  "icon-192.png": icon192,
  "icon-512.png": icon512,
  "icon-maskable-512.png": maskable512,
  "icon.svg": iconSvg,
  "icon-maskable.svg": maskableSvg,
};

export const MANIFEST = {
  "name": "Linear autopilot",
  "short_name": "Autopilot",
  "description": "Approve Linear tickets and launch Claude Code sessions in Supacode worktrees.",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0f0f0e",
  "theme_color": "#0f0f0e",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icons/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
};

// Network-only for everything (ticket data and CSRF tokens must never be stale). The one thing it
// adds is an offline page when the daemon isn't running, so the installed app explains itself.
export const SERVICE_WORKER = `const CACHE = "autopilot-v2";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icons/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
`;

export const offlinePage = (port: number, logPath: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10;url=/">
<title>Linear autopilot · offline</title>
<style>
  :root { --bg:#f4f4f1; --panel:#fff; --text:#1b1b19; --muted:#6d6d67; --border:#e4e4de; --code:#efefea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f0e; --panel:#191917; --text:#ededea; --muted:#9b9b94; --border:#2a2a27; --code:#262624; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
    font:14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; padding:16px; box-sizing:border-box; }
  .box { max-width:520px; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:28px; }
  img { width:44px; height:44px; }
  h1 { font-size:18px; margin:14px 0 6px; }
  p { color:var(--muted); margin:8px 0; }
  code { display:block; background:var(--code); border-radius:8px; padding:10px 12px; font:12.5px ui-monospace, Menlo, monospace;
    color:var(--text); white-space:pre-wrap; word-break:break-all; margin-top:6px; }
</style>
</head>
<body>
  <div class="box">
    <img src="/icons/icon.svg" alt="">
    <h1>linear-autopilot isn't running</h1>
    <p>The local daemon behind this app isn't answering on port ${port}. Restart it with:</p>
    <code>linear-autopilot service restart</code>
    <p>Logs: <code>${logPath}</code></p>
    <p>This page retries every 10 seconds.</p>
  </div>
</body>
</html>
`;

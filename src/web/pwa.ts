import serviceWorker from "./assets/service-worker.js" with { type: "text" };
export const SERVICE_WORKER = serviceWorker;

import apple from "../../public/icons/apple-touch-icon.png" with { type: "file" };
import favicon from "../../public/icons/favicon-32.png" with { type: "file" };
import icon192 from "../../public/icons/icon-192.png" with { type: "file" };
import icon512 from "../../public/icons/icon-512.png" with { type: "file" };
import maskable512 from "../../public/icons/icon-maskable-512.png" with { type: "file" };
import iconSvg from "../../public/icons/icon.svg" with { type: "file" };
import maskableSvg from "../../public/icons/icon-maskable.svg" with { type: "file" };

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
  "name": "Autopilot",
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

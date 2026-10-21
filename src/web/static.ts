import { LOG_PATH } from "../config/config";
import { ICONS, MANIFEST, SERVICE_WORKER } from "./pwa";
import { offlinePage } from "./views/offline";

/** PWA routes (an allowlist; nothing else on disk is reachable). Files are embedded when compiled. */
export function serveStatic(path: string, port: number): Response | null {
  const plain = { "X-Content-Type-Options": "nosniff" };
  if (path === "/manifest.webmanifest") {
    return Response.json(MANIFEST, { headers: { ...plain, "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } });
  }
  if (path === "/sw.js") {
    // The worker's own CSP governs its fetches, so it needs 'self' rather than the page's 'none'.
    return new Response(SERVICE_WORKER, {
      headers: { ...plain, "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'self'" },
    });
  }
  if (path === "/offline.html") {
    return new Response(offlinePage(port, LOG_PATH), {
      headers: { ...plain, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" },
    });
  }
  const icon = path.startsWith("/icons/") ? ICONS[path.slice("/icons/".length)] : undefined;
  if (icon) {
    return new Response(Bun.file(icon), {
      headers: { ...plain, "Content-Type": icon.endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "max-age=86400" },
    });
  }
  return null;
}

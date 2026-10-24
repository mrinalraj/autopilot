// The build replaces this token with the offline document's content hash.
const CACHE = "autopilot-cloud-offline-__OFFLINE_VERSION__";
const OFFLINE = "/offline.html";
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE, { cache: "reload" });
    if (!response.ok) throw new Error("Offline page unavailable");
    const cache = await caches.open(CACHE);
    await cache.put(OFFLINE, response);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("autopilot-cloud-offline-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // API, event streams, terminal traffic, mutations and assets stay network-only.
  if (request.method !== "GET" || request.mode !== "navigate" ||
      url.origin !== self.location.origin || url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/hooks/") || url.pathname === "/healthz") return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: "no-store" });
      if (response.status < 500) return response;
    } catch {}
    return (await (await caches.open(CACHE)).match(OFFLINE)) ||
      new Response("Autopilot server unavailable. Start autopilot-cloud start and retry.", {
        status: 503, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
  })());
});

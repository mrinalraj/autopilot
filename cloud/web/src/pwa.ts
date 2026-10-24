// The worker only caches a generic offline page, so it can activate without
// reloading open terminals or mixing cached application versions.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => {
        window.addEventListener("focus", () => { void registration.update().catch(() => {}); });
      })
      .catch((error) => console.warn("Offline fallback could not be installed", error));
  });
}

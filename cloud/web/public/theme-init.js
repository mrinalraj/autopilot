// Run before first paint, without inline script or a relaxed Content Security Policy.
(() => {
  let theme = "classic";
  try {
    const saved = localStorage.getItem("autopilot.theme");
    if (saved === "sage" || saved === "ember") theme = saved;
  } catch {
    // Storage can be unavailable; the default still renders normally.
  }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = {
    classic: "#111216",
    sage: "#2a3029",
    ember: "#101010",
  }[theme];
})();

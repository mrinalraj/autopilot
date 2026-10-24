import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "offline-version",
    apply: "build",
    closeBundle() {
      const version = createHash("sha256").update(readFileSync(resolve("dist/offline.html"))).digest("hex").slice(0, 16);
      const worker = resolve("dist/service-worker.js");
      writeFileSync(worker, readFileSync(worker, "utf8").replace("__OFFLINE_VERSION__", version));
    },
  }],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://127.0.0.1:4780", ws: true },
      "/healthz": "http://127.0.0.1:4780",
    },
  },
  build: { outDir: "dist", sourcemap: true },
});

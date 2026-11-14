import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: "apps/reports", base: "/reports/", publicDir: resolve("apps/portal/public"),
  plugins: [react()], build: { outDir: "../../dist/reports", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5175, strictPort: true, proxy: { "/api/reports/": "http://127.0.0.1:3212" } },
});

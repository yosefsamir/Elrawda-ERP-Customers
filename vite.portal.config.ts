import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/portal",
  plugins: [react()],
  build: { outDir: "../../dist/portal", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5174, proxy: { "/api": "http://127.0.0.1:3212" } },
});

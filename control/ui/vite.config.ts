import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  // `npm run dev` talks to the deployed Worker, so the UI can be worked on
  // without running the control plane locally.
  server: {
    proxy: { "/v1": { target: "https://barua-control.kelvineffect.workers.dev", changeOrigin: true } },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, run `npm run dev` here (Vite on :5173) and it proxies API calls to the
// Express server on :3000. In prod, `npm run build` emits web/dist, which the
// Express server serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Stage 0 (React migration): the bundle is built into frontend/react/ so
// the existing FastAPI StaticFiles mount serves it at /react/ with zero
// backend change. Vanilla remains the default at / until Stage 4.
// F9: react/react-dom/motion are split into a vendor chunk and every
// view but the landing Dashboard is a lazy chunk (App.tsx), so the
// first load pays for the shell plus Dashboard only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/react/",
  build: {
    outDir: "../frontend/react",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "motion"],
        },
      },
    },
  },
});

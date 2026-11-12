import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Stage 0 (React migration): the bundle is built into frontend/react/ so
// the existing FastAPI StaticFiles mount serves it at /react/ with zero
// backend change. Vanilla remains the default at / until Stage 4.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/react/",
  build: {
    outDir: "../frontend/react",
    emptyOutDir: true,
  },
});

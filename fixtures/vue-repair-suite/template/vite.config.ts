import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  cacheDir: ".vite-cache",
  server: { host: "127.0.0.1", strictPort: true },
  build: { outDir: "dist" }
});

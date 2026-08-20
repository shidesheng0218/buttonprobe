import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: ".vite-cache",
  server: {
    host: "127.0.0.1",
    strictPort: true
  },
  build: {
    outDir: "dist"
  }
});

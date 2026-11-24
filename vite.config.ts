import { defineConfig } from "vite";

// Dashboard site, served from GitHub Pages at /cleaner/.
// Output: dist/index.html and assets. Built first; emptyOutDir clears old output.
export default defineConfig({
  base: "/cleaner/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});

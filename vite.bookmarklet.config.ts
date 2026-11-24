import { defineConfig } from "vite";

// Bookmarklet build: one minified, self-contained script at dist/bookmarklet.js.
// Runs after the site build, so emptyOutDir stays off to keep the site files.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: "esbuild",
    lib: {
      entry: "src/bookmarklet/index.ts",
      name: "RepostCleanerBookmarklet",
      formats: ["iife"],
      fileName: () => "bookmarklet.js",
    },
  },
});

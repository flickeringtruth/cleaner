import { defineConfig } from "vite";

// Builds a single self-contained Userscripts-compatible file: dist/repost-cleaner.user.js
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/userscript.ts",
      name: "RepostCleaner",
      formats: ["iife"],
      fileName: () => "repost-cleaner.user.js",
    },
    rollupOptions: {
      output: {
        banner: `// ==UserScript==
// @name         Repost Cleaner
// @namespace    https://github.com/flickeringtruth/cleaner
// @version      0.1.0
// @description  Personal repost capture and cleanup helper for TikTok.
// @match        https://www.tiktok.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==`,
      },
    },
  },
});

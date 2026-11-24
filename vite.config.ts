import { defineConfig, type Plugin } from "vite";

const HEADER = `// ==UserScript==
// @name         Repost Cleaner
// @namespace    https://github.com/flickeringtruth/cleaner
// @version      0.1.0
// @description  Personal repost capture helper for TikTok. Stores no tokens, cookies or parameter values.
// @match        https://www.tiktok.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

// Library mode ignores rollup's banner option, so prepend the metadata block here.
const userscriptHeader = (): Plugin => ({
  name: "userscript-header",
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === "chunk") file.code = HEADER + file.code;
    }
  },
});

// Builds one self-contained Userscripts-compatible file: dist/repost-cleaner.user.js
export default defineConfig({
  plugins: [userscriptHeader()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/userscript.ts",
      name: "RepostCleaner",
      formats: ["iife"],
      fileName: () => "repost-cleaner.user.js",
    },
  },
});

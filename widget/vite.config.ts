import { defineConfig } from "vite";
import { resolve } from "node:path";

// 產出單一自帶樣式的 IIFE bundle：dist/embed.js
// 一行 <script src=".../embed.js"> 即可載入 widget。
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2019",
    lib: {
      entry: resolve(__dirname, "src/embed.ts"),
      name: "KefuWidget",
      formats: ["iife"],
      fileName: () => "embed.js",
    },
    rollupOptions: {
      output: {
        // CSS 以字串內聯進 JS(shadow DOM 注入),不另外產出 .css
        inlineDynamicImports: true,
      },
    },
  },
});

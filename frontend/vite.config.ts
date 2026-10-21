import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

/** App 版本(取自 package.json;CI 以 clients/scripts/sync-brand.mjs 同步) */
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * 原生建置(--mode native)專用:原生殼不使用 PWA。
 * - index.html 移除 manifest / theme-color / apple PWA meta。
 * - 產物移除 sw.js、manifest.json、status.html、features.html、shots/(保留 webview-too-old.html)。
 */
function nativeStripPwa(): Plugin {
  let outDir = "";
  return {
    name: "kefu-native-strip-pwa",
    apply: "build",
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    transformIndexHtml(html) {
      return html
        .replace(/[ \t]*<!--\s*PWA[^>]*-->[ \t]*\n?/g, "")
        .replace(/[ \t]*<link[^>]+rel="(?:manifest|apple-touch-icon)"[^>]*>[ \t]*\n?/g, "")
        .replace(
          /[ \t]*<meta[^>]+name="(?:theme-color|mobile-web-app-capable|apple-mobile-web-app-[a-z-]+)"[^>]*>[ \t]*\n?/g,
          "",
        );
    },
    // closeBundle:public/ 已複製進 outDir 之後才刪
    closeBundle() {
      if (!outDir) return;
      for (const f of ["sw.js", "manifest.json", "status.html", "features.html", "shots"]) {
        fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
      }
    },
  };
}

// Vite 設定:@ 指向 src;dev server 代理 /api 與 /ws 到後端(避免 CORS 與 WS 跨域)
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), mode === "native" ? nativeStripPwa() : null],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  // Tauri CLI 會注入 TAURI_ENV_* 建置變數
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // 保留 Rust / 原生建置的終端輸出
  clearScreen: false,
  server: {
    port: 5173,
    // Tauri devUrl 固定指向 5173,埠被佔用時直接失敗而不是換埠
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/android/**", "**/ios/**"],
    },
    proxy: {
      // 後端 REST 與 WebSocket 都代理過去,前端只需連同源即可
      "/api": {
        target: process.env.VITE_API_BASE || "http://localhost:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.VITE_API_BASE || "http://localhost:8000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));

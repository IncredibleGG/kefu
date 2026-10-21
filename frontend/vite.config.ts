import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Vite 設定:@ 指向 src;dev server 代理 /api 與 /ws 到後端(避免 CORS 與 WS 跨域)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
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
});

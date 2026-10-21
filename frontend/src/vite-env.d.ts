/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_MOCK?: "auto" | "on" | "off";
  /** 原生建置(.env.native)為 "native";web 建置未設 */
  readonly VITE_PLATFORM?: "native";
  /** 原生殼首次啟動預填的伺服器(預設 https://kf.56k.cc) */
  readonly VITE_DEFAULT_SERVER?: string;
  /** Android 是否已注入 google-services.json(on 才會呼叫推播 register,否則原生端會閃退) */
  readonly VITE_FCM_ENABLED?: "on" | "off";
  /** Tauri CLI 注入的建置環境(envPrefix 含 TAURI_ENV_) */
  readonly TAURI_ENV_PLATFORM?: string;
  readonly TAURI_ENV_DEBUG?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 建置期注入的 App 版本(vite.config.ts define,取自 package.json) */
declare const __APP_VERSION__: string;

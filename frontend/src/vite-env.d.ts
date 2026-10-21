/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_MOCK?: "auto" | "on" | "off";
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

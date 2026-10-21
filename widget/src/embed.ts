// 嵌入入口:一行 <script src=".../embed.js"> 即載入 widget。
//
// 設定來源(優先序:script data-* > window.KefuWidgetConfig):
//   <script src="/embed.js"
//           data-channel-key="xxxx"
//           data-api-base=""
//           data-tenant-id="uuid"
//           data-agent-token="jwt"
//           data-title="線上客服"
//           data-locale="en"
//           data-primary-color="#2563eb"
//           data-auto-open="false"></script>
//
// 或手動初始化(demo 用):
//   window.KefuWidget.init({ apiBase, channelKey, tenantId })
//
// 只要偵測到 channelKey 就自動初始化;否則掛上全域 API 等待手動 init。
import { KefuWidget } from "./widget";
import type { WidgetConfig } from "./types";

declare global {
  interface Window {
    KefuWidgetConfig?: Partial<WidgetConfig>;
    KefuWidget?: {
      init: (config: Partial<WidgetConfig>) => KefuWidget | undefined;
      destroy: () => void;
      /** SPA 宿主於路由變化時呼叫,上報一次頁面瀏覽(未帶參數時取當前 location/title)。 */
      trackPageView: (url?: string, title?: string) => void;
      _instance?: KefuWidget;
    };
  }
}

function readScriptConfig(): Partial<WidgetConfig> {
  const el =
    (document.currentScript as HTMLScriptElement | null) ||
    (document.querySelector('script[data-channel-key]') as HTMLScriptElement | null);
  if (!el) return {};
  const d = el.dataset;
  const cfg: Partial<WidgetConfig> = {};
  if (d.apiBase !== undefined) cfg.apiBase = d.apiBase;
  if (d.channelKey) cfg.channelKey = d.channelKey;
  if (d.tenantId) cfg.tenantId = d.tenantId;
  if (d.agentToken) cfg.agentToken = d.agentToken;
  if (d.displayName) cfg.displayName = d.displayName;
  if (d.locale) cfg.locale = d.locale;
  if (d.title) cfg.title = d.title;
  if (d.greeting) cfg.greeting = d.greeting;
  if (d.primaryColor) cfg.primaryColor = d.primaryColor;
  if (d.autoOpen !== undefined) cfg.autoOpen = d.autoOpen === "true" || d.autoOpen === "";
  if (d.pollIntervalMs) cfg.pollIntervalMs = Number(d.pollIntervalMs);
  return cfg;
}

function boot(): void {
  const cfg: Partial<WidgetConfig> = {
    ...readScriptConfig(),
    ...(window.KefuWidgetConfig || {}),
  };

  const api = {
    init(userCfg: Partial<WidgetConfig>): KefuWidget | undefined {
      const merged = { ...cfg, ...userCfg };
      if (!merged.channelKey) {
        console.warn("[kefu-widget] 缺少 channelKey,略過初始化");
        return undefined;
      }
      if (api._instance) api._instance.destroy();
      api._instance = new KefuWidget(merged as WidgetConfig);
      return api._instance;
    },
    destroy(): void {
      if (api._instance) {
        api._instance.destroy();
        api._instance = undefined;
      }
    },
    /** SPA 宿主主動上報頁面瀏覽;widget 未初始化時安靜略過。 */
    trackPageView(url?: string, title?: string): void {
      api._instance?.trackPageView(url, title);
    },
    _instance: undefined as KefuWidget | undefined,
  };
  window.KefuWidget = api;

  // 有 channelKey(且非等待手動 init)就自動載入
  if (cfg.channelKey && !window.KefuWidgetConfig?.manualInit) {
    api.init({});
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

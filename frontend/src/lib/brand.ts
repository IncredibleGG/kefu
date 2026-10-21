/** 白牌品牌 bootstrap:App 啟動時依網域解析租戶品牌,套用品牌色到 CSS 變數。 */
import { brandingApi } from "@/api/endpoints";
import { useBrand } from "@/stores/brand";
import { serverHost } from "@/lib/server";

/**
 * hex 色 → "H S% L%"(對齊設計系統 --brand 的 HSL 分量格式,見 styles/index.css)。
 * 支援 #RGB / #RRGGBB(可省略 #)。無法解析回 null。
 */
export function hexToHslComponents(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  let hue = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
        break;
    }
    hue /= 6;
  }
  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** 把品牌色套到 <html> 的 --brand(內聯樣式,亮/暗主題皆生效)。無效色略過。 */
export function applyBrandColor(hex: string | null | undefined): void {
  if (!hex) return;
  const hsl = hexToHslComponents(hex);
  if (!hsl) return;
  try {
    document.documentElement.style.setProperty("--brand", hsl);
  } catch {
    /* 無 document 時略過 */
  }
}

/**
 * 啟動時解析品牌:以伺服器 host(lib/server.serverHost;web 同源部署即 window.location.host,
 * 原生殼為使用者設定的伺服器)打公開端點。原生殼需在伺服器設定完成 / 更換後才呼叫。
 * - 非預設(命中租戶網域)→ 套品牌色到 --brand、更新分頁標題、填入品牌態供登入頁使用。
 * - 預設 / fetch 失敗 → 沿用內建預設,不套色也不崩(僅標記 ready 讓登入頁停止等待)。
 */
export async function bootstrapBranding(): Promise<void> {
  try {
    const host = serverHost();
    const brand = await brandingApi.resolveBranding(host);
    if (!brand.is_default) {
      applyBrandColor(brand.primary_color);
      if (brand.name) {
        try {
          document.title = brand.name;
        } catch {
          /* 略過 */
        }
      }
    }
    useBrand.getState().setBrand(brand);
  } catch {
    // fetch 失敗 / 後端未起:沿用內建預設,標記 ready
    useBrand.getState().setBrand({
      tenant_slug: null,
      name: "",
      logo_url: null,
      primary_color: null,
      branding: {},
      is_default: true,
    });
  }
}

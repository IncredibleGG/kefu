import { create } from "zustand";
import type { PublicBranding } from "@/types";

/**
 * 白牌品牌態(依網域解析後的租戶品牌)。
 * - 由 App 啟動時 bootstrapBranding() 以 window.location.host 打公開端點填入。
 * - is_default=true 表示未命中任何租戶網域 → 沿用內建預設(不套白牌)。
 * - 登入頁讀此態顯示租戶 logo + 名稱;CSS 變數 --brand 於 lib/brand 直接套到 <html>。
 */
interface BrandState {
  /** 是否已完成品牌解析(未完成前一律以內建預設呈現) */
  ready: boolean;
  /** 是否為內建預設品牌(true = 未套用白牌) */
  isDefault: boolean;
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  setBrand: (b: PublicBranding) => void;
}

export const useBrand = create<BrandState>((set) => ({
  ready: false,
  isDefault: true,
  name: null,
  logoUrl: null,
  primaryColor: null,
  setBrand: (b) =>
    set({
      ready: true,
      isDefault: b.is_default,
      name: b.name || null,
      logoUrl: b.logo_url ?? null,
      primaryColor: b.primary_color ?? null,
    }),
}));

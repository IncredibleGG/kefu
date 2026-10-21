import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhHant from "@/locales/zh-Hant/common.json";
import zhHans from "@/locales/zh-CN/common.json";
import en from "@/locales/en/common.json";
import ja from "@/locales/ja/common.json";
import ko from "@/locales/ko/common.json";
import es from "@/locales/es/common.json";
import fr from "@/locales/fr/common.json";
import de from "@/locales/de/common.json";
import pt from "@/locales/pt/common.json";
import ru from "@/locales/ru/common.json";
import th from "@/locales/th/common.json";
import vi from "@/locales/vi/common.json";
import id from "@/locales/id/common.json";
import ar from "@/locales/ar/common.json";
import tr from "@/locales/tr/common.json";
import hy from "@/locales/hy/common.json";

/** 支援語言清單(供語言切換器使用)。native = 該語言自稱。 */
export const LANGUAGES = [
  { code: "zh-Hant", native: "繁體中文" },
  { code: "zh-CN", native: "简体中文" },
  { code: "en", native: "English" },
  { code: "ja", native: "日本語" },
  { code: "ko", native: "한국어" },
  { code: "es", native: "Español" },
  { code: "fr", native: "Français" },
  { code: "de", native: "Deutsch" },
  { code: "pt", native: "Português" },
  { code: "ru", native: "Русский" },
  { code: "th", native: "ไทย" },
  { code: "vi", native: "Tiếng Việt" },
  { code: "id", native: "Bahasa Indonesia" },
  { code: "ar", native: "العربية" },
  { code: "tr", native: "Türkçe" },
  { code: "hy", native: "Հայերեն" },
] as const;

/** 由右到左書寫的語言。 */
export const RTL_LANGS = new Set(["ar"]);

const STORAGE_KEY = "kefu-lang";

function initialLang(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {
    /* localStorage 不可用時走預設 */
  }
  return "zh-Hant";
}

/** 套用書寫方向(RTL/LTR)到 <html>。 */
export function applyDir(lng: string): void {
  try {
    const dir = RTL_LANGS.has(lng) ? "rtl" : "ltr";
    document.documentElement.setAttribute("dir", dir);
    document.documentElement.setAttribute("lang", lng);
  } catch {
    /* SSR/無 document 時略過 */
  }
}

/** 切換語言:更新 i18n、記住選擇、套用書寫方向。 */
export function setLanguage(lng: string): void {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* 忽略 */
  }
  applyDir(lng);
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-Hant": { common: zhHant },
    "zh-CN": { common: zhHans },
    en: { common: en },
    ja: { common: ja },
    ko: { common: ko },
    es: { common: es },
    fr: { common: fr },
    de: { common: de },
    pt: { common: pt },
    ru: { common: ru },
    th: { common: th },
    vi: { common: vi },
    id: { common: id },
    ar: { common: ar },
    tr: { common: tr },
    hy: { common: hy },
  },
  lng: initialLang(),
  fallbackLng: "zh-Hant",
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

applyDir(i18n.language);

export default i18n;

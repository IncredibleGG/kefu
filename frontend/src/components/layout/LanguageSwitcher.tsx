import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, setLanguage } from "@/lib/i18n";

/** 語言切換器:每個坐席可各自選介面語言(記在 localStorage)。 */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  return (
    <label className="relative inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Languages className="h-4 w-4" aria-hidden />
      <select
        aria-label={t("common.language")}
        value={i18n.language}
        onChange={(e) => setLanguage(e.target.value)}
        className="cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/40"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
    </label>
  );
}

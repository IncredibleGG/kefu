import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** 服務小結彈出:分類 / 備註 / 滿意度(CSAT)沉澱進 CRM 與報表。
 *  closing=true(預設):送出後結束會話;closing=false:僅新增服務小結,不結束會話。 */
export function ServiceSummaryDialog({
  open,
  onOpenChange,
  onSubmit,
  closing = true,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (data: { category: string; note: string; csat: number }) => void | Promise<void>;
  /** true=結束會話並存檔(預設);false=僅記服務小結,不結束會話。 */
  closing?: boolean;
}) {
  const { t } = useTranslation();
  const CATEGORIES = [
    t("workspace.serviceSummary.categoryConsult"),
    t("workspace.serviceSummary.categoryAfterSales"),
    t("workspace.serviceSummary.categoryComplaint"),
    t("workspace.serviceSummary.categorySalesLead"),
    t("workspace.serviceSummary.categoryTechSupport"),
    t("workspace.serviceSummary.categoryOther"),
  ];
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [note, setNote] = useState("");
  // 內部處理評級:預設「不選」(0),僅在坐席明確評分時才會被記錄;
  // 與訪客 CSAT 分流,避免污染訪客滿意度報表。
  const [csat, setCsat] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 每次開啟時清掉上次的送出 / 錯誤狀態與評級(對話框關閉通常會卸載內容,仍保險重置)
  useEffect(() => {
    if (open) {
      setErr(null);
      setSubmitting(false);
      setCsat(0); // 預設不選:未評分不送出、不覆蓋訪客真實評分
    }
  }, [open]);

  // 送出:等待父層的非同步處理,成功才由父層關閉對話框;失敗保留內容並就地顯示錯誤。
  async function handleSubmit() {
    setErr(null);
    setSubmitting(true);
    try {
      await onSubmit({ category, note, csat });
    } catch {
      setErr(
        closing
          ? t("workspace.serviceSummary.closeFailed", { defaultValue: "結束會話失敗,請重試" })
          : t("workspace.serviceSummary.saveFailed", { defaultValue: "服務小結儲存失敗,請重試" }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("workspace.serviceSummary.title")}</DialogTitle>
          <DialogDescription>
            {closing
              ? t("workspace.serviceSummary.description")
              : t("workspace.serviceSummary.descriptionNoteOnly", {
                  defaultValue: "僅記錄本次服務小結,不會結束會話。",
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("workspace.serviceSummary.categoryLabel")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    category === c
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note">{t("workspace.serviceSummary.noteLabel")}</Label>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("workspace.serviceSummary.notePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>
                {t("workspace.serviceSummary.internalRatingLabel", {
                  defaultValue: "內部處理評級(選填)",
                })}
              </Label>
              {csat > 0 && (
                <button
                  type="button"
                  onClick={() => setCsat(0)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("workspace.serviceSummary.clearRating", { defaultValue: "清除" })}
                </button>
              )}
            </div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  // 再次點同一顆星可清除(回到未評分)
                  onClick={() => setCsat((cur) => (cur === n ? 0 : n))}
                  aria-label={t("workspace.serviceSummary.starLabel", { n })}
                  aria-pressed={n <= csat}
                >
                  <Star
                    className={cn(
                      "h-6 w-6 transition-colors",
                      n <= csat ? "fill-warning text-warning" : "text-muted-foreground/40",
                    )}
                  />
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("workspace.serviceSummary.internalRatingHint", {
                defaultValue:
                  "僅供內部品質參考,與訪客滿意度(CSAT)分開;未評分不送出,亦不會覆蓋或計入訪客評分。",
              })}
            </p>
          </div>
        </div>

        <DialogFooter>
          {err && (
            <p className="mr-auto self-center text-xs font-medium text-destructive">{err}</p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("workspace.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? t("workspace.serviceSummary.submitting", { defaultValue: "處理中…" })
              : closing
                ? t("workspace.serviceSummary.submit")
                : t("workspace.serviceSummary.saveOnly", { defaultValue: "儲存服務小結" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

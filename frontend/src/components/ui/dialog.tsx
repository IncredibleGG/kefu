import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * 手機(< md)版面:對話框改成「底部面板」樣式——貼齊畫面底部、全寬、上方圓角、
 * 最高 90dvh 並可內部捲動(長表單 / 鍵盤彈出時仍捲得到),底部與左右留 safe-area。
 * 全部以 max-md: 前綴撰寫,≥ md 沿用原本置中卡片,桌面像素不變;
 * 呼叫端傳入的 max-w-* / max-h-* 只影響桌面(max-md: 規則排序在後,手機上會蓋過)。
 * mx-auto:呼叫端若用 sm:max-w-* 在 640–767px 限寬,仍水平置中。
 */
const MOBILE_SHEET_CLS =
  "max-md:left-0 max-md:right-0 max-md:top-auto max-md:bottom-0 max-md:mx-auto max-md:max-w-none max-md:translate-none " +
  "max-md:max-h-[90dvh] max-md:overflow-y-auto max-md:overscroll-contain " +
  "max-md:rounded-b-none max-md:rounded-t-xl max-md:border-x-0 max-md:border-b-0 " +
  "max-md:pb-[calc(var(--safe-bottom)+1.25rem)] max-md:ps-[calc(var(--safe-start)+1.25rem)] max-md:pe-[calc(var(--safe-end)+1.25rem)] " +
  "max-md:data-[state=open]:animate-[kefu-sheet-up_0.22s_ease-out] max-md:motion-reduce:animate-none";

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const { t } = useTranslation();
  return (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-card p-5 shadow-lg",
        MOBILE_SHEET_CLS,
        className,
      )}
      {...props}
    >
      {/* 手機底部面板的把手(純裝飾;絕對定位不佔 grid 列,≥ md 不渲染) */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/30 md:hidden"
      />
      {children}
      {/* 觸控裝置:點擊區放大到 40px(圖示位置不變:right-1 + p-3 = right-3 + p-1) */}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm p-1 opacity-70 transition hover:opacity-100 hover:bg-accent pointer-coarse:right-1 pointer-coarse:top-1 pointer-coarse:p-3">
        <X className="h-4 w-4" />
        <span className="sr-only">{t("misc.close")}</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
  );
});
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // 手機:標題右側讓出關閉鈕的位置,長標題不會壓到 X
  return <div className={cn("flex flex-col gap-1.5 max-md:pe-8", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // 手機:按鈕放不下時換行,不撐出橫向捲軸
  return <div className={cn("flex justify-end gap-2 pt-2 max-md:flex-wrap", className)} {...props} />;
}
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";

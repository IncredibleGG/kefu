import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Sheet(抽屜 / 底部面板):以 Radix Dialog 為基礎(焦點鎖定、Esc 關閉、Android 返回鍵經
 * lib/mobile/backButton 派送 Escape 也能關閉)。
 * - side:bottom(預設,手機常用)/ start / end(依閱讀方向,RTL 自動鏡像)。
 * - 自動留 safe-area(瀏海 / Home 指示條),bottom 最高 90dvh 並可內部捲動。
 * - 無障礙:請放 <SheetTitle>(必要)與 <SheetDescription>;或傳 title / description 屬性,
 *   會以視覺隱藏方式渲染(螢幕閱讀器仍可讀)。
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-[kefu-sheet-fade_0.18s_ease-out]",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

export type SheetSide = "bottom" | "start" | "end";

const sideClasses: Record<SheetSide, string> = {
  bottom:
    "inset-x-0 bottom-0 max-h-[90dvh] w-full rounded-t-xl border-t pb-[calc(var(--safe-bottom)+1rem)] ps-[calc(var(--safe-start)+1rem)] pe-[calc(var(--safe-end)+1rem)] data-[state=open]:animate-[kefu-sheet-up_0.22s_ease-out]",
  start:
    "inset-y-0 start-0 h-full w-[85vw] max-w-sm border-e pt-[calc(var(--safe-top)+1rem)] pb-[calc(var(--safe-bottom)+1rem)] ps-[calc(var(--safe-start)+1rem)] pe-4 data-[state=open]:animate-[kefu-sheet-start_0.22s_ease-out]",
  end:
    "inset-y-0 end-0 h-full w-[85vw] max-w-sm border-s pt-[calc(var(--safe-top)+1rem)] pb-[calc(var(--safe-bottom)+1rem)] pe-[calc(var(--safe-end)+1rem)] ps-4 data-[state=open]:animate-[kefu-sheet-end_0.22s_ease-out]",
};

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: SheetSide;
  /** 隱藏右上角關閉鈕(例如自訂標頭時) */
  hideClose?: boolean;
  /** 視覺隱藏的標題(未自行放 SheetTitle 時提供,供螢幕閱讀器) */
  title?: string;
  /** 視覺隱藏的描述 */
  description?: string;
}

export const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ side = "bottom", hideClose, title, description, className, children, ...props }, ref) => {
    const { t } = useTranslation();
    return (
      <SheetPortal>
        <SheetOverlay />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "fixed z-50 flex flex-col gap-3 overflow-y-auto overscroll-contain border-border bg-card pt-4 shadow-lg outline-none",
            sideClasses[side],
            className,
          )}
          {...props}
        >
          {title && <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>}
          {description && (
            <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          )}
          {side === "bottom" && (
            <div aria-hidden className="mx-auto -mt-1 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
          )}
          {children}
          {!hideClose && (
            <DialogPrimitive.Close
              className={cn(
                "absolute end-3 rounded-sm p-1.5 opacity-70 transition hover:bg-accent hover:opacity-100 pointer-coarse:p-2",
                side === "bottom" ? "top-3" : "top-[calc(var(--safe-top)+0.75rem)]",
              )}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t("misc.close")}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = "SheetContent";

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 pe-8", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-auto flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";

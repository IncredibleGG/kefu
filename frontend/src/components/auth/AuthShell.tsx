/**
 * 登入 / 伺服器設定等「未登入畫面」的外框。
 * - 用 h-full + 內部捲動取代 min-h-screen(手機 100vh 會被網址列 / 鍵盤吃掉;#root 已是 100% 高)。
 * - 四邊加上 safe-area(瀏海、Home 指示條、Android 狀態列),桌面網頁時 safe-area 為 0,外觀不變。
 * - 內容垂直置中;內容比視窗高時(小螢幕 + 鍵盤)改為由上往下捲動。
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AuthShell({
  children,
  topRight,
  decorated = true,
  className,
}: {
  children: ReactNode;
  /** 右上角工具列(如主題切換),自動避開 safe-area */
  topRight?: ReactNode;
  /** 背景柔和光暈(沿用登入頁既有裝飾) */
  decorated?: boolean;
  className?: string;
}) {
  return (
    <div className="relative h-full overflow-y-auto overscroll-contain bg-background">
      {decorated && (
        <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand/10 blur-3xl" />
          <div className="absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-info/10 blur-3xl" />
        </div>
      )}
      {topRight && (
        <div className="fixed right-[calc(var(--safe-right)+1rem)] top-[calc(var(--safe-top)+1rem)] z-10 flex items-center gap-1">
          {topRight}
        </div>
      )}
      <div
        className={cn(
          "relative flex min-h-full flex-col items-center justify-center",
          "pb-[calc(var(--safe-bottom)+1.5rem)] pe-[calc(var(--safe-end)+1rem)] ps-[calc(var(--safe-start)+1rem)] pt-[calc(var(--safe-top)+3.5rem)] sm:pt-[calc(var(--safe-top)+1.5rem)]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

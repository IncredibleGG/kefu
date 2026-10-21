import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerGate } from "@/components/ServerGate";
import { queryClient } from "@/lib/query";
import { router } from "@/routes/router";
import { bootstrapBranding } from "@/lib/brand";
import { appReady, initPlatform } from "@/lib/platform";
import { hasServer, onServerChange } from "@/lib/server";
import { syncAuthToken } from "@/stores/auth";
import "@/lib/i18n";
import "@/styles/index.css";

async function start() {
  // 平台初始化必須在首屏前完成:原生儲存(伺服器 / token / 裝置 ID)讀回 localStorage、
  // 連結攔截器、resume / online / deep-link 監聽(initPlatform 內有逾時保護,不會卡住)
  await initPlatform();
  // store 建立時原生 token 可能尚未載入 → 對齊一次
  syncAuthToken();

  // 白牌品牌 bootstrap:依伺服器網域解析租戶品牌並套用(非阻塞;失敗沿用內建預設,不崩)。
  // 原生殼尚未設定伺服器時略過;設定 / 更換伺服器後重新執行。
  if (hasServer()) void bootstrapBranding();
  onServerChange(() => {
    if (hasServer()) void bootstrapBranding();
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <ServerGate>
            <RouterProvider router={router} />
          </ServerGate>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

  // 首屏繪製後再隱藏原生啟動畫面
  requestAnimationFrame(() => setTimeout(appReady, 0));
}

void start();

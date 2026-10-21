import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query";
import { router } from "@/routes/router";
import { bootstrapBranding } from "@/lib/brand";
import "@/lib/i18n";
import "@/styles/index.css";

// 白牌品牌 bootstrap:依當前網域解析租戶品牌並套用(非阻塞;失敗沿用內建預設,不崩)
void bootstrapBranding();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

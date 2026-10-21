import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ArrowLeft, Sun, Moon, LogOut, ChevronDown, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { useAuth } from "@/stores/auth";
import { useUi } from "@/stores/ui";
import { initials } from "@/lib/utils";

/**
 * 平台超管後台外殼:與租戶工作台分離的獨立框架。
 * 頂欄:平台標記 + 返回工作台 + 語言 / 主題 + 帳號(登出)。內容區可捲動。
 */
export function PlatformLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { staff, logout } = useAuth();
  const { theme, toggleTheme } = useUi();
  const [pwOpen, setPwOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-tight">{t("platform.title")}</h1>
          <p className="truncate text-xs text-muted-foreground">{t("platform.subtitle")}</p>
        </div>

        <div className="flex-1" />

        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4" /> {t("platform.backToApp")}
        </Button>

        <LanguageSwitcher />

        <SimpleTooltip label={t("topbar.theme")} side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={t("topbar.theme")}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </SimpleTooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-md p-1 hover:bg-accent">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials(staff?.display_name)}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm font-medium sm:block">{staff?.display_name}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-medium">{staff?.display_name}</span>
                <span className="text-xs font-normal text-muted-foreground">{staff?.email}</span>
              </div>
            </DropdownMenuLabel>
            <div className="px-2 pb-1.5">
              <Badge variant="brand">{t("platform.roleBadge")}</Badge>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setPwOpen(true)}>
              <KeyRound className="h-4 w-4" />
              {t("account.changePassword")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              <LogOut className="h-4 w-4" />
              {t("topbar.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Sun, Moon, LogOut, Languages, type LucideIcon } from "lucide-react";
import { visibleNav } from "@/components/layout/nav";
import { LANGUAGES, setLanguage } from "@/lib/i18n";
import { useUi } from "@/stores/ui";
import { useAuth } from "@/stores/auth";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Command {
  id: string;
  group: string;
  label: string;
  /** 額外可搜尋字串(路徑、英文別名等) */
  keywords?: string;
  icon?: LucideIcon;
  perform: () => void;
}

/** 對 haystack 做模糊比對:回傳分數(越小越優),不符則回 null。
 *  子字串命中優先(以出現位置為分數);否則退回子序列比對。 */
function fuzzyScore(haystack: string, q: string): number | null {
  if (!q) return 0;
  const idx = haystack.indexOf(q);
  if (idx >= 0) return idx;
  let i = 0;
  for (let c = 0; c < haystack.length && i < q.length; c++) {
    if (haystack[c] === q[i]) i++;
  }
  return i === q.length ? 1000 : null;
}

/**
 * ⌘K 全域命令列面板。
 * - 由 AppLayout 以受控 open/onOpenChange 掛載;快捷鍵監聽在 AppLayout。
 * - 命令來源:導覽(依角色過濾的 navItems 及其二級項)、動作(主題 / 登出)、切換語言。
 * - 無障礙:Radix Dialog 提供 role=dialog / aria-modal / focus trap / Esc / 點擊外部關閉;
 *   內部以 combobox + listbox 模式標註,開啟時聚焦輸入框。
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useUi();
  const logout = useAuth((s) => s.logout);
  const staff = useAuth((s) => s.staff);
  const roles = staff?.roles ?? ["agent"];

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 執行命令:先關閉面板再執行動作
  function run(fn: () => void) {
    onOpenChange(false);
    fn();
  }

  const commands = useMemo<Command[]>(() => {
    const navGroup = t("cmdk.groupNavigation", { defaultValue: "前往" });
    const actionGroup = t("cmdk.groupActions", { defaultValue: "動作" });
    const langGroup = t("cmdk.groupLanguage", { defaultValue: "切換語言" });
    const list: Command[] = [];

    // 導覽:一級項 + 其二級分頁(依角色過濾)
    for (const item of visibleNav(roles)) {
      const primary = t(item.labelKey);
      list.push({
        id: `nav-${item.key}`,
        group: navGroup,
        label: primary,
        keywords: `${item.to} ${item.key}`,
        icon: item.icon,
        perform: () => run(() => navigate(item.to)),
      });
      (item.secondary ?? []).forEach((sec, i) => {
        const secLabel = sec.labelKey ? t(sec.labelKey) : (sec.label ?? "");
        list.push({
          id: `nav-${item.key}-${i}`,
          group: navGroup,
          label: `${primary} · ${secLabel}`,
          keywords: `${sec.to} ${item.key}`,
          icon: item.icon,
          perform: () => run(() => navigate(sec.to)),
        });
      });
    }

    // 動作:切換主題
    list.push({
      id: "action-theme",
      group: actionGroup,
      label:
        theme === "dark"
          ? t("cmdk.toggleThemeToLight", { defaultValue: "切換為淺色主題" })
          : t("cmdk.toggleThemeToDark", { defaultValue: "切換為深色主題" }),
      keywords: "theme dark light 主題 深色 淺色",
      icon: theme === "dark" ? Sun : Moon,
      perform: () => run(toggleTheme),
    });

    // 動作:登出
    list.push({
      id: "action-logout",
      group: actionGroup,
      label: t("cmdk.logout", { defaultValue: "登出" }),
      keywords: "logout sign out 登出 退出",
      icon: LogOut,
      perform: () => run(logout),
    });

    // 切換語言:每個支援語言一項
    for (const l of LANGUAGES) {
      list.push({
        id: `lang-${l.code}`,
        group: langGroup,
        label: l.native,
        keywords: `${l.code} language 語言 ${l.native}`,
        icon: Languages,
        perform: () => run(() => setLanguage(l.code)),
      });
    }

    return list;
    // run 為穩定閉包(僅用到 onOpenChange);依賴變動時重建命令
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, navigate, roles, theme, toggleTheme, logout, onOpenChange]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands
      .map((cmd) => {
        const hay = `${cmd.label} ${cmd.keywords ?? ""} ${cmd.group}`.toLowerCase();
        return { cmd, score: fuzzyScore(hay, q) };
      })
      .filter((x): x is { cmd: Command; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.cmd);
  }, [commands, query]);

  // 開啟時重置查詢與選取並聚焦輸入框
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // 過濾結果變動時,把選取索引夾在有效範圍內
  useEffect(() => {
    setActive((a) => (filtered.length === 0 ? 0 : Math.min(a, filtered.length - 1)));
  }, [filtered.length]);

  // 選取項捲入視野
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (filtered.length ? (a + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (filtered.length ? (a - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length ? filtered.length - 1 : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.perform();
    }
  }

  const titleText = t("cmdk.title", { defaultValue: "命令面板" });
  const placeholder = t("cmdk.placeholder", { defaultValue: "輸入指令或搜尋頁面…" });

  let lastGroup: string | null = null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          aria-label={titleText}
          className="fixed left-1/2 top-[14%] z-50 flex max-h-[70vh] w-[92vw] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        >
          <DialogPrimitive.Title className="sr-only">{titleText}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{placeholder}</DialogPrimitive.Description>

          {/* 搜尋輸入(combobox) */}
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              role="combobox"
              aria-expanded
              aria-controls="cmdk-listbox"
              aria-autocomplete="list"
              aria-activedescendant={filtered.length ? `cmdk-opt-${active}` : undefined}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* 結果清單(listbox) */}
          <div
            ref={listRef}
            id="cmdk-listbox"
            role="listbox"
            aria-label={titleText}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("cmdk.empty", { defaultValue: "找不到符合的指令" })}
              </p>
            )}

            {filtered.map((cmd, index) => {
              const header = cmd.group !== lastGroup ? cmd.group : null;
              lastGroup = cmd.group;
              const Icon = cmd.icon;
              const isActive = index === active;
              return (
                <div key={cmd.id}>
                  {header && (
                    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {header}
                    </div>
                  )}
                  <button
                    id={`cmdk-opt-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onClick={() => cmd.perform()}
                    onMouseMove={() => setActive(index)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                      isActive ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{cmd.label}</span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 底部快捷鍵提示 */}
          <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className="rounded border border-border px-1">↑</kbd>
              <kbd className="ml-0.5 rounded border border-border px-1">↓</kbd>{" "}
              {t("cmdk.hintNavigate", { defaultValue: "選擇" })}
            </span>
            <span>
              <kbd className="rounded border border-border px-1">Enter</kbd>{" "}
              {t("cmdk.hintRun", { defaultValue: "執行" })}
            </span>
            <span>
              <kbd className="rounded border border-border px-1">Esc</kbd>{" "}
              {t("cmdk.hintClose", { defaultValue: "關閉" })}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合併 Tailwind class(去重衝突) */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 相對時間(繁中),用於會話列表/訊息時間 */
export function timeAgo(iso: string | number | Date): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "剛剛";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString("zh-Hant");
}

/** HH:MM 時間 */
export function hhmm(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString("zh-Hant", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 等待秒數轉為 mm:ss(排隊等待時長) */
export function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 取名字縮寫給頭像 fallback */
export function initials(name?: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** 簡易 uuid(mock 用) */
export function uid(): string {
  return "id-" + Math.random().toString(36).slice(2, 10);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

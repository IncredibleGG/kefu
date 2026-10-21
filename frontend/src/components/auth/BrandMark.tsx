/** 品牌標誌:白牌租戶有 logo 時用 logo,否則用內建圖示(與登入頁既有樣式一致)。 */
import { MessagesSquare, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrandMark({
  logoUrl,
  alt,
  icon: Icon = MessagesSquare,
  className,
}: {
  logoUrl?: string | null;
  alt?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={alt ?? ""}
        className={cn("h-12 w-12 rounded-xl object-contain shadow-lg", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-lg",
        className,
      )}
      aria-hidden={alt ? undefined : true}
    >
      <Icon className="h-6 w-6" />
    </div>
  );
}
